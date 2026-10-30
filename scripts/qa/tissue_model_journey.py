"""Scheduled source-only PUMA journey; never downloads or installs anything.

Use the existing engine interpreter. This performs real inference twice through
the native JSON worker's disposable preview/run path. The reference is a 64x64
OUTPUT ROI of the complete 1024x1024 TRAINING004 image, not a 64x64 input context.
All outputs stay in a new isolated evidence directory. This is engineering QA,
not independent accuracy, official-runtime parity, human review or qualification.
"""

from __future__ import annotations

import argparse
import base64
import builtins
import hashlib
import importlib.util
import io
import json
import os
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import time
from contextlib import suppress
from pathlib import Path

SOURCE_SHA = "34d13bdc3b05a9ab580f3edc63e826f38f1e1c10bafeacacb0d7573096226166"
REFERENCE_ARRAYS = {
    "class_labels": "155ab3509f1374519a2bc3887472b006ea0f68c12b1a40fab4446cf988f0c37c",
    "probabilities": "3833cada4c4c28081706e6e109059927eae232b0da0a03daef87a7f4054585da",
}
CONTEXT = {
    "x": 0,
    "y": 0,
    "width": 1024,
    "height": 1024,
    "z": 0,
    "t": 0,
    "c": 0,
    "level": 0,
}
OUTPUT = {**CONTEXT, "x": 960, "width": 64, "height": 64}
LIMITS = [
    "One 64x64 output ROI; full 1024x1024 normalization context and native tile grid preserved.",
    "Public TRAINING004 is not independent holdout; checkpoint fold membership is unavailable.",
    "No accuracy threshold, biological/clinical validation or official CUDA parity is established.",
    "Model grid spacing is not physical calibration; this fixture is measured in pixels.",
    "Class-4 epidermis does not establish a basal boundary; stroma is not automatically dermis.",
    "Softmax scores are not calibrated confidence. Original logits are not retained by Loci.",
    "Reviewed dispositions are automated QA transitions, not human scientific approval.",
    "Native JSON source journey only; no Electron picker, packaged binary or Codex-host acceptance.",
    "Exports require source verification and occur before the isolated source is taken offline.",
    "CPU/working-memory controls are not a hard macOS RSS limit or scientific qualification.",
]
STOP = False


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def check_stop():
    if STOP:
        raise InterruptedError("QA stop requested; owned processes will be cleaned up")


def encoded(value):
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode()


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(encoded(value) + b"\n")
    os.replace(temporary, path)


def digest(path):
    require(stat.S_ISREG(path.lstat().st_mode), f"Expected a plain file: {path}")
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024**2), b""):
            check_stop()
            value.update(chunk)
    return value.hexdigest()


def read_json(path):
    require(path.stat().st_size <= 16 * 1024**2, "JSON evidence exceeds its size bound")
    return json.loads(path.read_text())


def process_table():
    output = subprocess.run(
        ["ps", "-axo", "pid=,ppid=,pgid=,stat=,lstart="],
        capture_output=True,
        text=True,
        timeout=3,
        check=True,
    ).stdout
    rows = {}
    for line in output.splitlines():
        fields = line.split()
        if len(fields) >= 9:
            pid, ppid, pgid = map(int, fields[:3])
            rows[pid] = (ppid, pgid, fields[3], " ".join(fields[4:]))
    return rows


class OwnedProcess:
    """Bounded pipe I/O plus PID/start-identity tracking of detached descendants."""

    def __init__(self, command, *, repo, output, name, env, receipt):
        self.command, self.repo, self.output, self.name, self.env = (
            command,
            repo,
            output,
            name,
            env,
        )
        self.receipt = receipt
        self.child = None
        self.known = {}
        self.buffer = bytearray()
        self.stderr_bytes = 0
        self.last_scan = 0.0
        self.selector = selectors.DefaultSelector()
        self.logs = {}
        self.record = {"name": name, "command": command, "cwd": str(repo / "engine")}
        receipt.setdefault("processes", []).append(self.record)

    def remember(self, *, force=False):
        if not force and time.monotonic() - self.last_scan < 0.2:
            return
        table = process_table()
        roots = {
            pid
            for pid, identity in self.known.items()
            if pid in table and (table[pid][1], table[pid][3]) == identity
        }
        if self.child.pid not in self.known and self.child.poll() is None:
            roots.add(self.child.pid)
        while True:
            more = {pid for pid, row in table.items() if row[0] in roots}
            if more <= roots:
                break
            roots.update(more)
        for pid in roots:
            if pid in table:
                self.known[pid] = (table[pid][1], table[pid][3])
        self.last_scan = time.monotonic()

    def __enter__(self):
        check_stop()
        self.child = subprocess.Popen(
            self.command,
            cwd=self.repo / "engine",
            env=self.env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
            close_fds=True,
        )
        self.record["pid"] = self.child.pid
        try:
            for name in ("stdout", "stderr"):
                stream = getattr(self.child, name)
                os.set_blocking(stream.fileno(), False)
                self.selector.register(stream, selectors.EVENT_READ, name)
                suffix = "jsonl" if name == "stdout" else "log"
                self.logs[name] = (self.output / f"{self.name}.{name}.{suffix}").open(
                    "xb"
                )
            self.remember(force=True)
        except BaseException:
            with suppress(ProcessLookupError):
                os.killpg(self.child.pid, signal.SIGKILL)
            self.child.wait(timeout=3)
            self.selector.close()
            for stream in (
                *self.logs.values(),
                self.child.stdin,
                self.child.stdout,
                self.child.stderr,
            ):
                stream.close()
            raise
        return self

    def read_object(self, timeout):
        deadline = time.monotonic() + timeout
        while True:
            check_stop()
            self.remember()
            if b"\n" in self.buffer:
                line, _, remaining = self.buffer.partition(b"\n")
                self.buffer = bytearray(remaining)
                value = json.loads(line)
                require(type(value) is dict, "Worker response is not an object")
                return value
            require(time.monotonic() < deadline, f"{self.name} exceeded {timeout}s")
            events = self.selector.select(0.05)
            for key, _ in events:
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    self.selector.unregister(key.fileobj)
                    continue
                self.logs[key.data].write(chunk)
                self.logs[key.data].flush()
                if key.data == "stdout":
                    self.buffer.extend(chunk)
                    require(
                        len(self.buffer) <= 9 * 1024**2, "Worker response exceeds 9 MiB"
                    )
                else:
                    self.stderr_bytes += len(chunk)
                    require(
                        self.stderr_bytes <= 2 * 1024**2, "Worker stderr exceeds 2 MiB"
                    )
            if not self.selector.get_map() and b"\n" not in self.buffer:
                raise RuntimeError(f"{self.name} exited before its complete response")

    def call(self, method, params, timeout):
        identity = len(self.receipt.setdefault("calls", [])) + 1
        request = {"id": identity, "method": method, "params": params}
        record = {
            "process": self.name,
            "request": request,
            "started_monotonic": time.monotonic(),
        }
        self.receipt["calls"].append(record)
        self.child.stdin.write(encoded(request) + b"\n")
        self.child.stdin.flush()
        response = self.read_object(timeout)
        record["elapsed_seconds"] = time.monotonic() - record["started_monotonic"]
        record["response_sha256"] = hashlib.sha256(encoded(response)).hexdigest()
        require(response.get("id") == identity, "Worker replied to a different request")
        require("error" not in response, f"{method} failed: {response.get('error')}")
        require("result" in response, "Worker omitted its result")
        return response["result"]

    def __exit__(self, *_):
        # EOF normally exits the idle worker and is detected by active native
        # tissue supervision. On timeout, retain and kill observed child groups
        # too: they intentionally live outside the JSON parent's process group.
        cleanup_errors = []
        try:
            self.remember(force=True)
            self.child.stdin.close()
            try:
                self.child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.child.terminate()
                with suppress(subprocess.TimeoutExpired):
                    self.child.wait(timeout=3)
            self.remember(force=True)
            table = process_table()
            groups = {
                row[1]
                for pid, row in table.items()
                if pid in self.known and (row[1], row[3]) == self.known[pid]
            }
            if self.child.poll() is None:
                groups.add(self.child.pid)
            for group in groups:
                with suppress(ProcessLookupError):
                    os.killpg(group, signal.SIGKILL)
            self.child.wait(timeout=3)
            deadline = time.monotonic() + 2
            while True:
                table = process_table()
                survivors = [
                    pid
                    for pid, row in table.items()
                    if pid in self.known
                    and (row[1], row[3]) == self.known[pid]
                    and not row[2].startswith("Z")
                ]
                if not survivors or time.monotonic() >= deadline:
                    break
                time.sleep(0.05)
            require(not survivors, f"Owned live processes remain: {survivors}")
            self.record["cleanup"] = "direct-child-reaped; no-observed-live-descendants"
        except BaseException as error:  # noqa: BLE001 - record cleanup failure, never claim success
            cleanup_errors.append(f"{type(error).__name__}: {error}")
            # Always attempt the known root group even if process inspection fails.
            if self.child.poll() is None:
                with suppress(ProcessLookupError):
                    os.killpg(self.child.pid, signal.SIGKILL)
            with suppress(subprocess.TimeoutExpired):
                self.child.wait(timeout=3)
        finally:
            self.record["returncode"] = self.child.poll()
            self.record["observed_process_identities"] = self.known
            self.record["cleanup_errors"] = cleanup_errors
            self.selector.close()
            for stream in (*self.logs.values(), self.child.stdout, self.child.stderr):
                stream.close()
        require(
            not cleanup_errors, "Process cleanup could not be verified; inspect receipt"
        )


def load_array(path, expected=None):
    import numpy as np

    require(path.stat().st_size < 2 * 1024**2, "Fixture array exceeds its 2 MiB bound")
    require(not path.is_symlink(), "Fixture array cannot be a symlink")
    array = np.load(path, allow_pickle=False)
    if expected:
        require(list(array.shape) == expected["shape"], "Reference shape changed")
        require(str(array.dtype) == expected["dtype"], "Reference dtype changed")
        require(
            hashlib.sha256(array.tobytes()).hexdigest() == expected["sha256"],
            "Reference numerical bytes changed",
        )
    return array


def check_views(call, result, arrays, output, prefix):
    import numpy as np
    from PIL import Image

    display = {"low": 0, "high": 1, "gamma": 1, "color": "#ffffff"}
    for field, key in (
        ("tissue_classes", "class_labels"),
        ("compartments", "labels"),
        ("epidermis_score", "image"),
    ):
        request = {"result_id": result["id"], "display": display}
        if field == "epidermis_score":
            request["labels"] = False
        elif field == "tissue_classes":
            request["label_field"] = field
        # The omitted field must select effective compartments by default.
        viewed = call("result_view", request)
        require(
            viewed["field"] == field and viewed["basis"],
            "View lost its scientific field/basis",
        )
        raw = base64.b64decode(viewed["image"].split(",", 1)[1], validate=True)
        (output / f"{prefix}-{field}.png").write_bytes(raw)
        if field == "epidermis_score":
            require(
                viewed["label_image"] is None, "Score view unexpectedly contains labels"
            )
            expected = np.repeat(
                np.round(arrays[key].astype(np.float64) * 255)[..., None], 3, -1
            )
            np.testing.assert_array_equal(
                np.asarray(Image.open(io.BytesIO(raw))), expected.astype(np.uint8)
            )
        else:
            raw = base64.b64decode(
                viewed["label_image"].split(",", 1)[1], validate=True
            )
            (output / f"{prefix}-{field}-labels.png").write_bytes(raw)
            labels = arrays[key].astype(np.uint32)
            rgb = np.stack(
                [labels * multiplier % 223 + 32 for multiplier in (67, 97, 137)], -1
            )
            expected = np.concatenate(
                [rgb, np.where(labels > 0, 150, 0)[..., None]], -1
            ).astype(np.uint8)
            np.testing.assert_array_equal(
                np.asarray(Image.open(io.BytesIO(raw))), expected
            )


def retained_check(config_path):
    """Fresh-process reopen with both source decoding and model execution forbidden."""
    config = read_json(config_path)
    repo, output = Path(config["repo"]), Path(config["output"])
    sys.path.insert(0, str(repo / "engine" / "src"))
    original_import = builtins.__import__

    def no_torch(name, *args, **kwargs):
        require(
            name != "torch" and not name.startswith("torch."),
            "Retained reopen imported Torch",
        )
        return original_import(name, *args, **kwargs)

    builtins.__import__ = no_torch
    import numpy as np
    from loci_engine import research_tissue_integration as integration
    from loci_engine.research_project import ResearchProject
    from loci_engine.workbench import Workbench

    def forbidden(*_args, **_kwargs):
        raise AssertionError("Retained reopen attempted source/model access")

    integration.store.resolve_approved_weights = forbidden
    Workbench._session = forbidden
    require(
        not Path(config["registered_source"]).exists(),
        "Isolated raw source is still online",
    )
    require(
        not Path(os.environ["LOCI_MODEL_HOME"]).exists(),
        "Cold process unexpectedly has a model store",
    )
    verified = []
    for name in ("original", "restored"):
        project = ResearchProject(config["projects"][name])
        workbench = Workbench(project)
        try:
            for label in ("original", "corrected"):
                expected = read_json(output / "exports" / label / "result.json")[
                    "result"
                ]
                result = project.result(expected["id"])
                require(
                    result == expected,
                    "Cold result changed after export/portable restore",
                )
                require(
                    project.review_state(result["id"])["disposition"] == "reviewed",
                    "Cold reopen lost its QA review disposition",
                )
                arrays = {
                    key: project.load_array(value)
                    for key, value in result["arrays"].items()
                }
                for key, array in arrays.items():
                    np.testing.assert_array_equal(
                        array, load_array(output / "exports" / label / f"{key}.npy")
                    )
                check_views(
                    workbench.execute,
                    result,
                    arrays,
                    output / "views",
                    f"cold-{name}-{label}",
                )
                verified.append(
                    {
                        "project": name,
                        "result_id": result["id"],
                        "revision_hash": result["revision_hash"],
                    }
                )
        finally:
            workbench.close()
    report = {
        "schema": "loci.tissue-cold-retained-qa/v1",
        "verified": verified,
        "source_decode": False,
        "model_access": False,
        "torch_import": False,
    }
    write_json(output / "cold-retained-check.json", report)
    print(encoded(report).decode(), flush=True)


def journey(args, receipt):
    import numpy as np

    repo, evidence, output = args.repo, args.evidence, args.output
    require(sys.flags.isolated == 1, "Invoke the existing engine Python with -I")
    specification = importlib.util.find_spec("loci_engine")
    require(
        specification is not None and specification.origin is not None,
        "The selected interpreter cannot locate loci_engine",
    )
    origin = Path(specification.origin).resolve(strict=True)
    require(
        origin.parent == repo / "engine/src/loci_engine",
        "The selected interpreter resolves a different Loci checkout",
    )
    receipt["resolved_engine_package"] = str(origin)
    freeze = read_json(
        evidence / "tissue-integration-source-freeze-review-repaired.json"
    )
    source_hashes = {}
    for relative, expected in freeze["files"].items():
        require(
            not Path(relative).is_absolute() and ".." not in Path(relative).parts,
            "Invalid source freeze path",
        )
        actual = digest(repo / relative)
        require(actual == expected, f"Frozen tissue source changed: {relative}")
        source_hashes[relative] = actual
    for name in (
        "puma_backend",
        "puma_architecture",
        "tissue_model_profiles",
        "tissue_model_store",
    ):
        relative = f"engine/src/loci_engine/{name}.py"
        source_hashes[relative] = digest(repo / relative)
    receipt["source_hashes"] = source_hashes
    receipt["source_freeze_sha256"] = digest(
        evidence / "tissue-integration-source-freeze-review-repaired.json"
    )
    receipt["git_head"] = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repo,
        capture_output=True,
        text=True,
        timeout=5,
        check=True,
    ).stdout.strip()
    receipt["script_sha256"] = digest(Path(__file__).resolve())
    receipt["interpreter"] = {
        "path": sys.executable,
        "sha256": digest(Path(sys.executable).resolve()),
        "version": sys.version,
    }
    prototype = evidence / "public-data/epidermis-route/prototype"
    source = prototype / "inputs/training_set_primary_roi_004/source.tif"
    weights = prototype.parent / "safe-inspection/checkpoint_best.network_weights.pth"
    conversion = weights.with_suffix(weights.suffix + ".receipt.json")
    reference_root = evidence / "puma-engine-repaired"
    reference = read_json(reference_root / "receipt.json")["backend"]
    require(
        digest(source) == SOURCE_SHA == reference["request"]["source_sha256"],
        "Wrong public fixture",
    )
    require(
        reference["request"]["context_selection"] == CONTEXT,
        "Reference context is not 1024x1024",
    )
    require(
        reference["request"]["output_selection"] == OUTPUT,
        "Reference output ROI changed",
    )
    references = {}
    for key, sha in REFERENCE_ARRAYS.items():
        require(
            reference["artifacts"][key]["sha256"] == sha,
            "Wrong retained reference prediction",
        )
        references[key] = load_array(
            reference_root / f"{key}.npy", reference["artifacts"][key]
        )
    receipt["inputs"] = {
        "source": {"path": str(source), "sha256": SOURCE_SHA},
        "reference_receipt_sha256": digest(reference_root / "receipt.json"),
        "reference_npy_file_sha256": {
            key: digest(reference_root / f"{key}.npy") for key in references
        },
        "weights_sha256": digest(weights),
        "conversion_receipt_sha256": digest(conversion),
    }
    for directory in ("inputs", "exports", "views"):
        (output / directory).mkdir()
    source_copy = output / "inputs/TRAINING004.tif"
    shutil.copyfile(source, source_copy)
    require(digest(source_copy) == SOURCE_SHA, "Isolated source copy differs")
    project, restored = output / "journey.loci-study", output / "restored.loci-study"
    env = {**os.environ, "LOCI_MODEL_HOME": str(output / "models")}
    receipt["environment_override"] = {"LOCI_MODEL_HOME": env["LOCI_MODEL_HOME"]}
    command = [sys.executable, "-I", "-m", "loci_engine.worker"]
    with OwnedProcess(
        command, repo=repo, output=output, name="native", env=env, receipt=receipt
    ) as worker:

        def rpc(method, **params):
            return worker.call(method, params, args.timeout)

        def execute(operation, request):
            return rpc(
                "research_execute",
                project=str(project),
                operation=operation,
                request=request,
            )

        profiles = rpc("tissue_model_profiles")["profiles"]
        require(len(profiles) == 1, "Unexpected tissue catalogue")
        item = profiles[0]
        profile = item["profile"]
        require(
            item["store"]["state"] == "missing", "Model store is not isolated and empty"
        )
        require(
            item["runtime"]["status"] == "metadata-matches-unverified",
            "Exact optional runtime is unavailable; nothing was installed",
        )
        require(
            profile["contract_sha256"] == reference["profile"]["contract_sha256"],
            "Reference profile contract changed",
        )
        require(
            receipt["inputs"]["weights_sha256"] == profile["model"]["sha256"],
            "Wrong weights",
        )
        require(
            receipt["inputs"]["conversion_receipt_sha256"]
            == profile["model"]["conversion_receipt_sha256"],
            "Wrong conversion receipt",
        )
        imported = rpc(
            "tissue_model_import",
            profile_id=profile["id"],
            weights_path=str(weights),
            receipt_path=str(conversion),
        )
        require(
            imported["profiles"][0]["store"]["state"] == "provisioned-unverified",
            "Managed import did not publish its exact pair",
        )
        receipt["profiles_before_import"], receipt["profiles_after_import"] = (
            profiles,
            imported,
        )
        rpc(
            "research_create",
            path=str(project),
            title="Public TRAINING004 tissue integration QA",
        )
        snapshot = rpc(
            "research_import",
            project=str(project),
            paths=[str(source_copy)],
            kind="files",
        )
        require(
            len(snapshot["sources"]) == 1,
            "Import did not register exactly one public source",
        )
        source_record = snapshot["sources"][0]
        require(
            source_record["sha256"] == SOURCE_SHA,
            "Registered source fingerprint changed",
        )
        request = {
            "source_id": source_record["id"],
            "source_sha256": SOURCE_SHA,
            "series": 0,
            "context_selection": CONTEXT,
            "output_selection": OUTPUT,
            "declared_stain": "hematoxylin-eosin",
            "profile_id": profile["id"],
            "profile_contract_sha256": profile["contract_sha256"],
            "runtime_contract_sha256": hashlib.sha256(
                encoded(profile["runtime"])
            ).hexdigest(),
            "weights_sha256": profile["model"]["sha256"],
            "rgb_policy": profile["input"]["rgb_policy"],
            "working_bytes": profile["resources"]["minimum_working_bytes"],
        }
        receipt["accepted_request"] = request
        status = execute("tissue_model_status", request)
        require(
            status["status"]["model_execution_performed"] is False,
            "Status executed a model",
        )

        def task(operation, body, key):
            job = rpc(
                "research_submit",
                project=str(project),
                operation=operation,
                request=body,
                request_key=key,
            )
            require(
                job["request"]
                == {"source_id": request["source_id"], "task_request": body},
                "Durable request normalization changed",
            )
            result = rpc("research_run", project=str(project), job_id=job["id"])
            require(
                result["job"]["state"] == "succeeded", f"{operation} did not succeed"
            )
            return result

        preview = task("tissue_model_preview", request, "public-preview-v1")
        require(
            preview["job"]["result_ids"] == [] and preview["adopted"] is False,
            "Preview adopted a result",
        )
        token = {key: preview[key] for key in ("preview_id", "preview_hash")}
        cached = execute("task_preview_get", {"job_id": preview["job"]["id"]})[
            "preview"
        ]["output"]
        require(
            {key: cached[key] for key in token} == token,
            "Durable preview token changed",
        )
        adoption = task("tissue_model_run", token, "public-adoption-v1")
        original = adoption["result"]
        require(
            adoption["job"]["result_ids"] == [original["id"]],
            "Adoption did not publish exactly one result",
        )
        retry = rpc(
            "research_submit",
            project=str(project),
            operation="tissue_model_run",
            request=token,
            request_key="public-adoption-v1",
        )
        require(retry["id"] == adoption["job"]["id"], "Exact retry created another job")
        require(
            rpc("research_run", project=str(project), job_id=retry["id"])["job"][
                "result_ids"
            ]
            == [original["id"]],
            "Completed retry changed adopted result",
        )
        require(
            set(original["arrays"])
            == {"labels", "image", "class_labels", "probabilities"},
            "Retained arrays changed or logits were invented",
        )
        arrays = {}
        for key, descriptor in original["arrays"].items():
            path = project / "artifacts" / (descriptor["sha256"] + ".npy")
            require(
                digest(path) == descriptor["sha256"], "Retained NPY file hash changed"
            )
            arrays[key] = load_array(path)
        comparisons = {}
        for key, expected in references.items():
            actual = arrays[key]
            require(
                actual.shape == expected.shape and actual.dtype == expected.dtype,
                "Prior engine array shape/dtype differs; comparison is not applicable",
            )
            comparisons[key] = {
                "bitwise_equal": actual.tobytes() == expected.tobytes(),
                "raw_sha256": hashlib.sha256(actual.tobytes()).hexdigest(),
                "maximum_absolute_difference": float(
                    np.abs(
                        actual.astype(np.float64) - expected.astype(np.float64)
                    ).max()
                ),
                "shape": list(actual.shape),
                "dtype": str(actual.dtype),
            }
        receipt["same_engine_reference_comparisons"] = comparisons
        require(
            all(value["bitwise_equal"] for value in comparisons.values()),
            "Same-context predictions differ from the prior engine evidence",
        )
        np.testing.assert_array_equal(arrays["image"], references["probabilities"][4])
        require(
            arrays["image"].tobytes() == references["probabilities"][4].tobytes(),
            "Retained score is not the exact original class-4 probability plane",
        )
        np.testing.assert_array_equal(arrays["labels"] > 0, arrays["class_labels"] == 4)
        record = execute("result", {"result_id": original["id"]})
        inference = record["provenance"]["tissue_model"]["receipt"]["inference"]
        for key in ("request", "decoding", "preprocessing", "tiles"):
            require(
                inference[key] == reference[key],
                f"Reference applicability changed: {key}",
            )
        require(
            original["geometry"]["unit"] == "pixel",
            "Unexpected physical calibration; inspect before claiming comparability",
        )
        require(original["geometry"]["axes"] == "YX", "Result axes changed")
        np.testing.assert_array_equal(
            original["geometry"]["affine"],
            [[1, 0, 0, 960], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
        )
        require(
            all(row["intensity"] == {} for row in record["measurements"]),
            "Tissue result fabricated raw intensity measurements",
        )
        receipt["runtime"] = inference["runtime"]
        check_views(execute, original, arrays, output / "views", "original")
        info = execute(
            "correction_info",
            {"result_id": original["id"], "revision_hash": original["revision_hash"]},
        )
        require(
            info["label_ids"] and info["measurement_channels"] == [],
            "Fixture has no editable epidermis or fabricated intensity channels",
        )
        correction = {
            "result_id": original["id"],
            "revision_hash": original["revision_hash"],
            "working_bytes": request["working_bytes"],
            "operations": [
                {
                    "op": "delete",
                    "label": info["label_ids"][0],
                    "expected_input_sha256": info["label_sha256"],
                }
            ],
        }
        corrected = task("correct_result", correction, "public-correction-v1")["result"]
        require(corrected["review"] is None, "Correction silently inherited a review")
        for key in ("class_labels", "probabilities", "image"):
            require(
                corrected["arrays"][key] == original["arrays"][key],
                "Correction changed immutable model predictions",
            )
        require(
            corrected["arrays"]["labels"] != original["arrays"]["labels"],
            "Correction did not change effective labels",
        )
        changed = corrected["arrays"]["labels"]
        changed_path = project / "artifacts" / (changed["sha256"] + ".npy")
        require(
            digest(changed_path) == changed["sha256"],
            "Corrected label artifact changed",
        )
        check_views(
            execute,
            corrected,
            {**arrays, "labels": load_array(changed_path)},
            output / "views",
            "corrected",
        )
        for label, result in (("original", original), ("corrected", corrected)):
            binding = {
                "result_id": result["id"],
                "revision_hash": result["revision_hash"],
            }
            rpc(
                "research_review",
                project=str(project),
                **binding,
                disposition="reviewed",
            )
            rpc(
                "research_export",
                project=str(project),
                **binding,
                destination=str(output / "exports" / label),
            )
        archive = output / "portable.loci-study.zip"
        rpc("research_project_export", project=str(project), destination=str(archive))
        imported = rpc(
            "research_project_import", archive=str(archive), destination=str(restored)
        )
        require(
            {r["id"] for r in imported["results"]} == {original["id"], corrected["id"]},
            "Portable restore lost or invented results",
        )
        receipt["results"] = {"original": original, "corrected": corrected}
        receipt["portable_sha256"] = digest(archive)
    disposable = [
        pid
        for pid, identity in worker.known.items()
        if pid != worker.child.pid and identity[0] == pid
    ]
    require(
        len(disposable) == 2,
        "Did not observe exactly two disposable preview/run processes",
    )
    receipt["observed_native_disposable_pids"] = disposable
    # Only the owned copy is taken offline; the authorized reference is unchanged.
    offline = source_copy.with_suffix(".offline.tif")
    source_copy.rename(offline)
    config = {
        "repo": str(repo),
        "output": str(output),
        "registered_source": str(source_copy),
        "projects": {"original": str(project), "restored": str(restored)},
    }
    config_path = output / "cold-check-input.json"
    write_json(config_path, config)
    cold_env = {**os.environ, "LOCI_MODEL_HOME": str(output / "absent-cold-models")}
    cold_command = [
        sys.executable,
        "-I",
        str(Path(__file__).resolve()),
        "--verify-retained",
        str(config_path),
    ]
    with OwnedProcess(
        cold_command,
        repo=repo,
        output=output,
        name="cold",
        env=cold_env,
        receipt=receipt,
    ) as cold:
        receipt["cold_reopen"] = cold.read_object(args.timeout)
        require(
            receipt["cold_reopen"].get("schema") == "loci.tissue-cold-retained-qa/v1",
            "Cold reopen did not finish",
        )
        require(cold.child.wait(timeout=3) == 0, "Cold verification process failed")
    require(digest(source) == digest(offline) == SOURCE_SHA, "Source changed during QA")
    require(
        digest(weights) == receipt["inputs"]["weights_sha256"]
        and digest(conversion) == receipt["inputs"]["conversion_receipt_sha256"],
        "Original approved model files changed during QA",
    )
    require(
        digest(Path(__file__).resolve()) == receipt["script_sha256"],
        "QA harness changed during execution",
    )
    for relative, sha in source_hashes.items():
        require(
            digest(repo / relative) == sha, f"Source code changed during QA: {relative}"
        )
    receipt["artifact_hashes"] = {
        str(path.relative_to(output)): digest(path)
        for folder in (output / "exports", output / "views")
        for path in sorted(folder.rglob("*"))
        if path.is_file()
    }
    receipt["status"] = "passed-source-engineering-qa-only"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo", type=Path, default=Path(__file__).resolve().parents[2]
    )
    parser.add_argument("--evidence", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--verify-retained", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.verify_retained:
        retained_check(args.verify_retained)
        return 0
    require(
        os.name == "posix", "This source harness requires POSIX process supervision"
    )
    require(args.output is not None, "--output is required")
    require(1 <= args.timeout <= 600, "Per-operation timeout must be 1-600 seconds")
    args.repo = args.repo.resolve(strict=True)
    args.evidence = (
        args.evidence or args.repo / ".loci/evidence/2026-10-30/research-program"
    ).resolve(strict=True)
    args.output = args.output.absolute()
    require(
        args.output.parent.resolve(strict=True) == args.output.parent,
        "Output parent must be canonical",
    )
    require(
        args.output.is_relative_to(args.repo / ".loci/evidence"),
        "Output must be isolated repository-local evidence",
    )
    args.output.mkdir(exist_ok=False)

    def stop(_signum, _frame):
        global STOP
        STOP = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    receipt = {
        "schema": "loci.tissue-source-journey/v1",
        "status": "running",
        "limits": LIMITS,
        "command": list(sys.orig_argv),
        "scientific_qualification": "not-established",
    }
    started = time.monotonic()
    try:
        journey(args, receipt)
        return 0
    except BaseException as error:  # noqa: BLE001 - retain failed QA evidence and return nonzero
        receipt["status"] = "failed"
        receipt["error"] = {"type": type(error).__name__, "message": str(error)}
        print(f"Tissue QA failed: {error}", file=sys.stderr)
        return 1
    finally:
        receipt["elapsed_seconds"] = time.monotonic() - started
        write_json(args.output / "receipt.json", receipt)
        print(f"Retained QA receipt: {args.output / 'receipt.json'}", flush=True)


if __name__ == "__main__":
    raise SystemExit(main())
