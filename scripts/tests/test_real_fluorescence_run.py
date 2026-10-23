"""Serial-runner contracts exercised with synthetic CLI/MCP transport stubs only."""

import asyncio
import copy
import importlib.util
from contextlib import asynccontextmanager
from pathlib import Path

import pytest

SPEC = importlib.util.spec_from_file_location(
    "fluorescence_run", Path(__file__).parents[1] / "qa/real_fluorescence_run.py"
)
driver = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(driver)


class Document:
    def __init__(self, value):
        self.value = value

    def model_dump(self, **_kwargs):
        return self.value


def inputs(tmp_path, *, dataset="BBBC039v1", sealed=False, qualification=False):
    def save(name, document):
        path = tmp_path / name
        driver.write_json(path, document)
        return path

    worker = tmp_path / "worker"
    worker.write_bytes(b"synthetic executable; never executed")
    worker.chmod(0o700)
    code_file = tmp_path / "source.py"
    code_file.write_text("# synthetic code identity\n")
    code = save(
        "code.json",
        {
            "schema": "loci.source-identity/v1",
            "source_commit": "a" * 40,
            "source_tree": "b" * 40,
            "dirty": True,
            "files": [driver.identity(code_file)],
        },
    )
    archive = tmp_path / "archive.zip"
    archive.write_bytes(b"synthetic archive identity; no real images")
    members, images = [], []
    for index in range(2):
        raw, original = (
            tmp_path / f"raw-{index}.tif",
            tmp_path / f"original-{index}.tif",
        )
        raw.write_bytes(f"synthetic prepared {index}".encode())
        original.write_bytes(f"synthetic original {index}".encode())
        record = driver.identity(original)
        members.append(record)
        item = {
            "derived": driver.identity(raw),
            "axes": "YX",
            "shape": [4, 5],
            "dtype": "uint16",
        }
        if dataset == "BBBC039v1":
            item.update(
                reference_filename=f"field-{index}.png",
                source=record,
                official_split="test" if sealed else "training",
                role="sealed-test" if sealed else "development",
            )
        else:
            dna = tmp_path / f"dna-{index}.bmp"
            dna.write_bytes(b"synthetic DNA original")
            members.append(driver.identity(dna))
            item.update(
                well=f"{'C' if sealed else 'A'}0{index + 1}",
                sources=[record, driver.identity(dna)],
                axes="CYX",
                shape=[2, 4, 5],
                dtype="uint8",
            )
        images.append(item)
    source = save(
        "sources.json",
        {
            "sources": [
                {
                    "key": "039-images" if dataset == "BBBC039v1" else "013-bmp",
                    **driver.identity(archive),
                    "members": members,
                }
            ]
        },
    )
    prepared = save("prepared.json", {"images": images})
    runtime = {key: "synthetic-runtime" for key in driver.RUNTIME_KEYS}
    channel = 0 if dataset == "BBBC039v1" else 1
    recipe_document = {
        "schema": "loci.real-fluorescence.run-recipe/v1",
        "dataset": dataset,
        "classical": {
            "selection": {
                "x": 0,
                "y": 0,
                "width": 5,
                "height": 4,
                "c": channel,
                "z": 0,
                "t": 0,
                "level": 0,
            },
            "profile_id": "loci-classical",
            "settings": {"threshold": 1},
            "working_bytes": 64 * 1024**2,
            "measurement_channels": [channel],
        },
        "perinuclear": {
            "signal_channel": 0,
            "radius_px": 5,
            "working_bytes": 64 * 1024**2,
            "control": "fixed synthetic control",
        }
        if dataset == "BBBC013v1"
        else None,
        "runtime": runtime,
        "limits": {"cpu_seconds": 60, "memory_bytes": 64 * 1024**2, "concurrency": 1},
    }
    recipe = save("recipe.json", recipe_document)
    argv = [
        "--dataset",
        dataset,
        "--split",
        "sealed-test" if sealed else "development",
        "--mode",
        "qualification" if qualification else "exploratory",
        "--output",
        str(tmp_path / "output"),
        "--poll-seconds",
        "0.001",
    ]
    files = {
        "worker": worker,
        "prepared-manifest": prepared,
        "source-manifest": source,
        "recipe": recipe,
        "code-manifest": code,
    }
    if qualification:
        executable, asar = tmp_path / "Loci", tmp_path / "app.asar"
        executable.write_bytes(b"synthetic app executable")
        asar.write_bytes(b"synthetic asar")
        candidate = save(
            "candidate.json",
            {
                "schema": "loci.candidate-identity/v1",
                "source_commit": "a" * 40,
                "source_tree": "b" * 40,
                "files": {
                    "executable": driver.identity(executable),
                    "app_asar": driver.identity(asar),
                    "worker": driver.identity(worker),
                },
            },
        )
        freeze = save(
            "freeze.json",
            {
                "schema": "loci.real-fluorescence.settings-freeze/v1",
                "dataset": dataset,
                **{
                    key: driver.identity(path)
                    for key, path in {
                        "prepared_manifest": prepared,
                        "source_manifest": source,
                        "driver_recipe": recipe,
                        "code_manifest": code,
                        "candidate_identity": candidate,
                    }.items()
                },
            },
        )
        files.update({"frozen-settings": freeze, "candidate-identity": candidate})
    for key, path in files.items():
        argv += [
            "--" + key,
            str(path),
            "--" + key + "-sha256",
            driver.identity(path)["sha256"],
        ]
    return driver.parser().parse_args(argv), recipe_document


class NativeStub:
    def __init__(
        self,
        recipe,
        *,
        fail_first=False,
        lose_submit_response=False,
        uncertain=False,
        mismatch_runtime=False,
    ):
        self.recipe = recipe
        self.calls, self.jobs, self.results, self.sources = [], {}, {}, {}
        self.active = 0
        self.fail_first, self.lose_submit_response, self.uncertain = (
            fail_first,
            lose_submit_response,
            uncertain,
        )
        self.mismatch_runtime = mismatch_runtime
        self.lost = False

    def cli(self, _worker, _sha, args, _root):
        args = list(map(str, args))
        self.calls.append(("cli", args))
        command = args[0]
        if command == "create":
            Path(args[args.index("--project") + 1]).mkdir()
        elif command == "import":
            source_id = f"{len(self.sources) + 1:032x}"
            source = {"id": source_id, "sha256": driver.identity(args[-1])["sha256"]}
            self.sources[source_id] = source
            self.current_source = source
            return {"sources": [source]}
        elif command == "policy":
            specification = driver.read_json(args[-1][1:])
            assert specification["limits"]["concurrency"] == 1
            driver.write_json(
                args[args.index("--destination") + 1],
                {"schema": "loci.agent-policy/v4", **specification},
            )
        return {}

    @asynccontextmanager
    async def session(self, _worker, _policy, field):
        self.field = field
        yield self

    async def list_tools(self):
        return Document({"tools": [{"name": "validate_action"}]})

    async def call_tool(self, name, arguments):
        self.calls.append((name, copy.deepcopy(arguments)))
        value = {}
        if name == "action_guide":
            value = {
                "actions": [
                    {
                        "operation": arguments["operation"],
                        "request_schema": {"type": "object"},
                    }
                ]
            }
        elif name == "validate_action":
            value = {"authorized": True, "request": arguments["request"]}
        elif name == "submit_action":
            key = arguments["request_key"]
            if key not in self.jobs:
                assert self.active == 0, "Driver overlapped native jobs"
                self.active += 1
                result_id = f"{len(self.jobs) + 100:032x}"
                self.jobs[key] = {
                    "id": key,
                    "state": "queued",
                    "result_ids": [result_id],
                }
                channel = (
                    0
                    if arguments["operation"] == "perinuclear_run"
                    else self.recipe["classical"]["selection"]["c"]
                )
                selection = {**self.recipe["classical"]["selection"], "c": channel}
                result = {
                    "id": result_id,
                    "revision_hash": "c" * 64,
                    "source_id": self.current_source["id"],
                    "source_sha256": self.current_source["sha256"],
                    "parent_id": arguments["request"].get("result_id"),
                    "selection": selection,
                    "arrays": {
                        "image": {"shape": [4, 5], "dtype": "uint8"},
                        "labels": {"shape": [4, 5], "dtype": "uint32"},
                    },
                    "provenance": {
                        "selection": selection,
                        "runtime": self.recipe["runtime"],
                        "accepted_request": arguments["request"],
                    },
                }
                self.results[result_id] = result
            if self.uncertain or self.lose_submit_response and not self.lost:
                self.lost = True
                raise ConnectionError(
                    "synthetic response lost after durable submission"
                )
            value = {"job": self.jobs[key]}
        elif name == "job_status":
            job = self.jobs[arguments["job_id"]]
            self.active = 0
            job.update(
                state="failed"
                if self.fail_first and len(self.jobs) == 1
                else "succeeded",
                owned_worker_active=False,
            )
            value = {"job": job}
        elif name == "result":
            result = copy.deepcopy(self.results[arguments["result_id"]])
            if self.mismatch_runtime:
                result["provenance"]["runtime"]["backend"] = "wrong-runtime"
            value = {"result": result, "provenance": result["provenance"]}
        elif name == "review_history":
            value = {"current_review_sha256": "d" * 64}
        elif name == "review_result":
            assert arguments["request"]["reason"] == driver.REVIEW_REASON
            assert (
                "no pixel-mask assessment, visual review"
                in arguments["request"]["coverage"]
            )
            value = {"review": {"actor": "agent"}}
        elif name == "export_result":
            folder = self.field / "exports" / arguments["filename"]
            folder.mkdir()
            result = copy.deepcopy(self.results[arguments["result_id"]])
            for array_name in result["arrays"]:
                path = folder / (array_name + ".npy")
                path.write_bytes(b"synthetic native artifact; no pixel interpretation")
                result["arrays"][array_name].update(
                    {
                        key: value
                        for key, value in driver.identity(path).items()
                        if key != "path"
                    }
                )
            driver.write_json(
                folder / "result.json",
                {"result": result, "source": self.current_source},
            )
            driver.write_json(
                folder / "loci-export.json",
                {
                    "schema": "loci.export-marker/v1",
                    "result_id": result["id"],
                    "revision_hash": result["revision_hash"],
                },
            )
            driver.write_json(
                folder / "manifest.json",
                {
                    "schema": "loci.export-manifest/v1",
                    "result_id": result["id"],
                    "revision_hash": result["revision_hash"],
                    "files": [
                        {
                            "name": path.name,
                            "sha256": driver.identity(path)["sha256"],
                            "size_bytes": path.stat().st_size,
                        }
                        for path in sorted(folder.iterdir())
                    ],
                },
            )
        return Document({"isError": False, "structuredContent": value, "content": []})


def execute(args, stub):
    return asyncio.run(driver.run(args, cli=stub.cli, session_factory=stub.session))


def test_parser_requires_explicit_worker_and_identity_inputs():
    with pytest.raises(SystemExit):
        driver.parser().parse_args(["--dataset", "BBBC013v1"])


@pytest.mark.parametrize("dataset", ["BBBC039v1", "BBBC013v1"])
def test_serial_real_interface_flow_preserves_parent_child_receipts_without_visual_claims(
    tmp_path, dataset
):
    args, recipe = inputs(tmp_path, dataset=dataset)
    stub = NativeStub(recipe)
    result = execute(args, stub)
    assert result["status"] == "completed"
    assert len(result["fields"]) == 2
    assert all(
        len(field["exports"]) == (2 if dataset == "BBBC013v1" else 1)
        for field in result["fields"]
    )
    assert result["qualification_outcomes_computed"] is False
    assert result["review_actor"] == "agent"
    assert all(
        (args.output / f"field-{i:04d}/receipt.json").is_file() for i in range(2)
    )
    assert stub.active == 0
    actions = [request for name, request in stub.calls if name == "submit_action"]
    if dataset == "BBBC013v1":
        assert [action["operation"] for action in actions] == [
            "classical_run",
            "perinuclear_run",
        ] * 2
        assert actions[0]["request"]["selection"]["c"] == 1
        assert (
            actions[1]["request"]["signal_channel"] == 0
            and actions[1]["request"]["radius_px"] == 5
        )


def test_sealed_selection_requires_qualification_and_independent_freeze(tmp_path):
    args, recipe = inputs(tmp_path, sealed=True)
    stub = NativeStub(recipe)
    result = execute(args, stub)
    assert result["status"] == "failed" and "Sealed" in result["error"]
    assert not stub.calls


def test_sealed_run_with_complete_frozen_candidate_is_bound_to_all_three_artifacts(
    tmp_path,
):
    args, recipe = inputs(tmp_path, sealed=True, qualification=True)
    result = execute(args, NativeStub(recipe))
    assert result["status"] == "completed"
    assert "candidate_identity" in result["pins"]


@pytest.mark.parametrize(
    "changed", ["worker", "code", "original", "prepared", "recipe", "candidate"]
)
def test_changed_input_rejects_before_any_native_execution_and_retains_failure(
    tmp_path, changed
):
    args, recipe = inputs(tmp_path, qualification=True)
    paths = {
        "worker": args.worker,
        "code": tmp_path / "source.py",
        "original": tmp_path / "original-0.tif",
        "prepared": tmp_path / "raw-0.tif",
        "recipe": args.recipe,
        "candidate": tmp_path / "app.asar",
    }
    path = paths[changed]
    original = path.read_bytes()
    path.write_bytes(bytes([original[0] ^ 1]) + original[1:])  # Same-size substitution.
    stub = NativeStub(recipe)
    result = execute(args, stub)
    assert result["status"] == "failed" and "identity changed" in result["error"]
    assert not stub.calls
    assert driver.read_json(args.output / "run-receipt.json")["status"] == "failed"


def test_lost_submit_response_retries_identical_request_key_without_duplicate_job(
    tmp_path,
):
    args, recipe = inputs(tmp_path)
    stub = NativeStub(recipe, lose_submit_response=True)
    result = execute(args, stub)
    assert result["status"] == "completed"
    submissions = [value for name, value in stub.calls if name == "submit_action"]
    assert submissions[0] == submissions[1]
    assert len(stub.jobs) == 2
    assert (
        "transport-failure" in (args.output / "field-0000/transcript.jsonl").read_text()
    )


def test_failed_analysis_is_retained_without_retry_and_next_field_still_attempted(
    tmp_path,
):
    args, recipe = inputs(tmp_path)
    stub = NativeStub(recipe, fail_first=True)
    result = execute(args, stub)
    assert result["status"] == "failed"
    assert result["fields"][0]["status"] == "failed"
    assert result["fields"][1]["status"].startswith("native-execution-complete")
    assert len([name for name, _ in stub.calls if name == "submit_action"]) == 2
    assert (args.output / "field-0000/receipt.json").is_file()


def test_uncertain_active_job_stops_all_later_submissions_and_records_not_run_fields(
    tmp_path,
):
    args, recipe = inputs(tmp_path)
    stub = NativeStub(recipe, uncertain=True)
    result = execute(args, stub)
    assert result["status"] == "failed"
    assert len(stub.jobs) == 1
    assert result["fields"][1]["status"] == "not-run"
    assert "Task may remain active" in result["fields"][0]["error"]


def test_runtime_mismatch_prevents_agent_review_and_export(tmp_path):
    args, recipe = inputs(tmp_path)
    stub = NativeStub(recipe, mismatch_runtime=True)
    result = execute(args, stub)
    assert result["status"] == "failed"
    assert not any(name in {"review_result", "export_result"} for name, _ in stub.calls)


def test_existing_output_and_symlink_worker_are_never_reused(tmp_path):
    args, recipe = inputs(tmp_path)
    args.output.mkdir()
    with pytest.raises(FileExistsError):
        execute(args, NativeStub(recipe))
    args.output.rmdir()
    linked = tmp_path / "linked-worker"
    linked.symlink_to(args.worker)
    args.worker = linked
    result = execute(args, NativeStub(recipe))
    assert result["status"] == "failed" and "symlink" in result["error"]


@pytest.mark.parametrize(
    "change", ["concurrency", "DNA-channel", "ring-radius", "ring-signal"]
)
def test_recipe_rejects_protocol_or_resource_changes_before_execution(tmp_path, change):
    args, recipe = inputs(tmp_path, dataset="BBBC013v1")
    if change == "concurrency":
        recipe["limits"]["concurrency"] = 2
    elif change == "DNA-channel":
        recipe["classical"]["selection"]["c"] = 0
    elif change == "ring-radius":
        recipe["perinuclear"]["radius_px"] = 6
    else:
        recipe["perinuclear"]["signal_channel"] = 1
    # Supply a new explicit recipe pin: fixed protocol guards still apply.
    args.recipe.unlink()
    driver.write_json(args.recipe, recipe)
    args.recipe_sha256 = driver.identity(args.recipe)["sha256"]
    stub = NativeStub(recipe)
    result = execute(args, stub)
    assert result["status"] == "failed" and not stub.calls


def test_explicit_selection_cannot_cross_declared_split(tmp_path):
    args, _ = inputs(tmp_path, dataset="BBBC013v1")
    manifest = driver.read_json(args.prepared_manifest)
    manifest["images"][1]["well"] = "C01"
    with pytest.raises(ValueError, match="explicit split"):
        driver.selected_entries(manifest, args.dataset, "development", ["C01"])


def test_sealed_qualification_cannot_reuse_unrelated_freeze(tmp_path):
    args, recipe = inputs(tmp_path, sealed=True, qualification=True)
    freeze = driver.read_json(args.frozen_settings)
    freeze["driver_recipe"]["sha256"] = "f" * 64
    args.frozen_settings.unlink()
    driver.write_json(args.frozen_settings, freeze)
    args.frozen_settings_sha256 = driver.identity(args.frozen_settings)["sha256"]
    stub = NativeStub(recipe)
    result = execute(args, stub)
    assert result["status"] == "failed" and "driver_recipe" in result["error"]
    assert not stub.calls


def test_terminal_state_waits_for_owned_worker_to_stop_before_next_job(tmp_path):
    args, recipe = inputs(tmp_path)

    class DelayedStop(NativeStub):
        def __init__(self, recipe):
            super().__init__(recipe)
            self.seen = set()

        async def call_tool(self, name, arguments):
            document = await super().call_tool(name, arguments)
            if name == "job_status" and arguments["job_id"] not in self.seen:
                self.seen.add(arguments["job_id"])
                document.value["structuredContent"]["job"]["owned_worker_active"] = True
                self.active = 1
            return document

    stub = DelayedStop(recipe)
    result = execute(args, stub)
    assert result["status"] == "completed"
    assert len([name for name, _ in stub.calls if name == "job_status"]) == 4


def test_native_tool_failure_is_retained_without_analysis_submission(tmp_path):
    args, recipe = inputs(tmp_path)

    class Denied(NativeStub):
        async def call_tool(self, name, arguments):
            if name == "validate_action":
                self.calls.append((name, arguments))
                return Document(
                    {
                        "isError": True,
                        "content": [
                            {"type": "text", "text": "synthetic native rejection"}
                        ],
                    }
                )
            return await super().call_tool(name, arguments)

    stub = Denied(recipe)
    result = execute(args, stub)
    assert result["status"] == "failed"
    assert all(field["status"] == "failed" for field in result["fields"])
    assert not any(name == "submit_action" for name, _ in stub.calls)


def test_native_cli_failure_keeps_stdout_stderr_and_transcript(tmp_path, monkeypatch):
    args, _ = inputs(tmp_path)

    def failed_cli(command, *, stdout, stderr, **_kwargs):
        stdout.write(b'{"native":"partial response"}')
        stderr.write(b"synthetic native import rejection")
        return driver.subprocess.CompletedProcess(command, 1)

    monkeypatch.setattr(driver.subprocess, "run", failed_cli)
    with pytest.raises(RuntimeError, match="Native CLI failed"):
        driver.cli_call(args.worker, args.worker_sha256, ["import"], tmp_path)
    assert (
        tmp_path / "cli-001.stderr"
    ).read_text() == "synthetic native import rejection"
    assert "cli-response" in (tmp_path / "transcript.jsonl").read_text()


def test_job_timeout_requests_cancel_and_never_treats_cancel_request_as_termination():
    class Pending:
        def __init__(self):
            self.calls = []

        async def call(self, name, _arguments):
            self.calls.append(name)
            if name == "validate_action":
                return {"authorized": True}
            if name == "submit_action":
                return {"job": {"id": "pending-job"}}
            return {
                "job": {
                    "id": "pending-job",
                    "state": "queued",
                    "owned_worker_active": True,
                }
            }

    pending = Pending()
    with pytest.raises(driver.UncertainJob, match="termination not proven"):
        asyncio.run(
            driver.execute_action(pending, "classical_run", {}, "same-key", 0, 0)
        )
    assert pending.calls == [
        "validate_action",
        "submit_action",
        "job_status",
        "cancel_job",
    ]
