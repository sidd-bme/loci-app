"""Bounded adversarial checks for public-data adapters and independent oracles."""

import hashlib
import importlib.util
import json
import stat
import zipfile
from pathlib import Path

import numpy as np
import pytest
import tifffile
from PIL import Image


def load(name):
    path = Path(__file__).parents[1] / "qa" / f"real_fluorescence_{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


prep = load("prepare")
oracle = load("evaluate")


@pytest.mark.parametrize(
    "name",
    ["../outside", "/absolute", "a/../../outside", "C:/drive", "a\\outside", "a//b"],
)
def test_zip_rejects_unsafe_paths_before_creating_destination(tmp_path, name):
    archive = tmp_path / "bad.zip"
    with zipfile.ZipFile(archive, "w") as stream:
        stream.writestr(name, b"data")
    with pytest.raises(ValueError):
        prep.safe_extract(archive, tmp_path / "out")
    assert not (tmp_path / "out").exists()


def test_zip_rejects_links_duplicate_case_and_large_metadata(tmp_path, monkeypatch):
    for mode in ("link", "duplicate", "large"):
        archive = tmp_path / f"{mode}.zip"
        with zipfile.ZipFile(archive, "w") as stream:
            if mode == "link":
                item = zipfile.ZipInfo("link")
                item.create_system = 3
                item.external_attr = (stat.S_IFLNK | 0o777) << 16
                stream.writestr(item, "elsewhere")
            elif mode == "duplicate":
                stream.writestr("file", "a")
                stream.writestr("FILE", "b")
            else:
                stream.writestr("file", "12345")
                monkeypatch.setattr(prep, "MAX_MEMBER", 4)
        with pytest.raises(ValueError):
            prep.safe_extract(archive, tmp_path / mode)
        assert not (tmp_path / mode).exists()


def test_zip_exact_extraction_never_overwrites_and_refuses_symlink_root(tmp_path):
    archive = tmp_path / "source.zip"
    with zipfile.ZipFile(archive, "w") as stream:
        stream.writestr("folder/raw.bin", b"\x00\xff\x12")
    records = prep.safe_extract(archive, tmp_path / "out")
    assert (tmp_path / "out/folder/raw.bin").read_bytes() == b"\x00\xff\x12"
    assert records[0]["bytes"] == 3
    with pytest.raises(FileExistsError):
        prep.safe_extract(archive, tmp_path / "out")
    (tmp_path / "link").symlink_to(tmp_path / "out", target_is_directory=True)
    with pytest.raises(ValueError):
        prep.safe_extract(archive, tmp_path / "link/child")


def test_replay_rejects_changed_source_even_same_size(tmp_path):
    raw = tmp_path / "raw"
    raw.write_bytes(b"abc")
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({"sources": [prep.identity(raw)]}))
    assert prep.verify_manifest(manifest)["verified_files"] == 1
    raw.write_bytes(b"abd")
    with pytest.raises(ValueError, match="identity changed"):
        prep.verify_manifest(manifest)


def test_official_colour_decode_keeps_touching_values_separate_and_diagonal_connected():
    red = np.array([[1, 2, 0, 1], [0, 1, 0, 0], [0, 0, 0, 1]], dtype=np.uint8)
    rgb = np.stack([red, red * 2, red * 3], axis=2)
    labels = oracle.decode_039_rgb(rgb)
    assert labels[0, 0] == labels[1, 1]  # full 2D connectivity
    assert labels[0, 1] != labels[0, 0]  # touching different red values
    assert labels[0, 3] != labels[2, 3]  # disconnected reused red value
    assert len(np.unique(labels[labels > 0])) == 4


def test_instance_matching_threshold_count_and_split_merge_are_independent():
    truth = np.array([[1, 1, 0, 2, 2], [1, 1, 0, 2, 2]], dtype=np.uint16)
    renamed = np.where(truth == 1, 44, np.where(truth == 2, 9, 0)).astype(np.uint32)
    result = oracle.instance_metrics(truth, renamed)
    assert result["scores"][0]["f1"] == 1
    assert result["count_error_absolute"] == 0
    merged = np.where(truth > 0, 1, 0).astype(np.uint16)
    result = oracle.instance_metrics(truth, merged)
    assert result["scores"][0]["true_positive"] == 1  # exactly .5 inclusive
    assert result["scores"][1]["true_positive"] == 0
    assert result["merge_prediction_any_overlap"] == 1
    assert result["scores"][0]["false_negative"] == 1
    assert result["count_error_signed"] == -1
    result = oracle.instance_metrics(merged, truth)
    assert result["split_reference_any_overlap"] == 1
    assert result["count_error_signed"] == 1


def test_undefined_empty_and_malformed_states_are_not_perfect_success():
    empty = np.zeros((4, 5), dtype=np.uint16)
    result = oracle.instance_metrics(empty, empty)
    assert result["scores"][0]["f1"] is None
    assert result["count_error_relative"] is None
    with pytest.raises(ValueError):
        oracle.instance_metrics(empty, empty.T)
    for bad in (
        np.ones((4, 5), dtype=float),
        -np.ones((4, 5), dtype=int),
        np.zeros((0, 5), dtype=int),
    ):
        with pytest.raises(ValueError):
            oracle.labels_2d(bad)


def test_matching_maximizes_eligible_pair_count_before_summed_iou():
    # Overlap table [[70, 10], [10, 0]]: maximizing plain IoU chooses one
    # .7778 pair; threshold .1 permits two .125 pairs and must choose both.
    truth = np.array([1] * 80 + [2] * 10, dtype=np.uint16).reshape(9, 10)
    predicted = np.array([1] * 70 + [2] * 10 + [1] * 10, dtype=np.uint16).reshape(9, 10)
    score = oracle.instance_metrics(truth, predicted, thresholds=(0.1,))["scores"][0]
    assert score["true_positive"] == 2
    assert score["matched_iou_sum"] == 0.25


@pytest.mark.parametrize(
    "url", ["http://data.broadinstitute.org/x", "https://example.com/data.zip"]
)
def test_download_rejects_unapproved_initial_origin_without_network(tmp_path, url):
    with pytest.raises(ValueError, match="approved official dataset host"):
        prep.download(url, tmp_path / "file.zip")
    assert not (tmp_path / "file.zip").exists()


def test_raw_uint16_arithmetic_preserves_precision_and_large_sum():
    raw = np.full((520, 696), 65535, dtype=np.uint16)
    labels = np.ones(raw.shape, dtype=np.uint32)
    row = oracle.masked_measurements(raw, labels)[0]
    assert row == {
        "label": 1,
        "area_pixels": 361920,
        "sum": 23718427200,
        "mean": 65535.0,
    }
    with pytest.raises(ValueError):
        oracle.masked_measurements(raw.astype(float), labels)


def test_ring_exact_euclidean_radius_excludes_collisions_and_all_nuclei():
    labels = np.zeros((15, 19), dtype=np.uint16)
    labels[7, 6] = 1
    labels[7, 12] = 2
    labels[0, 0] = 3
    ring, excluded = oracle.perinuclear_rings(labels, radius=3)
    assert ring[7, 3] == 1  # distance 3 inclusive
    assert ring[4, 3] == 0  # Euclidean sqrt(18), not a square dilation
    assert ring[7, 9] == 0  # claimed by two candidates
    assert np.all(ring[labels > 0] == 0)
    assert excluded == [{"label": 3, "reason": "nucleus touches image boundary"}]


def test_enrichment_zero_ring_exclusion_and_well_not_cell_control_unit():
    labels = np.zeros((21, 21), dtype=np.uint16)
    labels[10, 10] = 1
    raw = np.ones(labels.shape, dtype=np.uint8)
    raw[10, 10] = 8
    assert oracle.enrichment(raw, labels)["well_median_ratio"] == 8
    raw[:] = 0
    result = oracle.enrichment(raw, labels)
    assert result["well_median_ratio"] is None
    assert result["excluded"][0]["reason"] == "empty or zero-mean perinuclear ring"
    result = oracle.control_summary([1, 1.1], [4, 4.1])
    assert result["positive_expected_direction"] is True
    assert result["negative_wells"] == result["positive_wells"] == 2
    assert result["z_prime_sample_sd"] == pytest.approx(1 - np.sqrt(0.02), abs=1e-14)
    assert result["z_prime_sample_sd"] != pytest.approx(
        0.9
    )  # population SD would give .9
    with pytest.raises(ValueError):
        oracle.control_summary([1, 1], [1, 1])


def test_boundary_excluded_nucleus_still_competes_with_nearby_interior_ring():
    labels = np.zeros((11, 11), dtype=np.uint32)
    labels[0, 5], labels[4, 5] = 1, 2
    ring, excluded = oracle.perinuclear_rings(labels, radius=3)
    assert ring[2, 5] == 0
    assert int((ring == 2).sum()) == 21
    assert not (ring == 1).any()
    assert excluded == [{"label": 1, "reason": "nucleus touches image boundary"}]
    raw = np.ones(labels.shape, dtype=np.uint8)
    raw[4, 5] = 10
    y, x = np.indices(labels.shape)
    contested = (
        ((y**2 + (x - 5) ** 2) <= 9)
        & (((y - 4) ** 2 + (x - 5) ** 2) <= 9)
        & (labels == 0)
    )
    assert int(contested.sum()) == 7
    raw[contested] = 100
    result = oracle.enrichment(raw, labels, radius=3)
    assert result["well_median_ratio"] == 10.0
    assert result["objects"][0]["perinuclear_ring"]["area_pixels"] == 21


def historical_split_fixture(tmp_path, monkeypatch):
    metadata = tmp_path / "extracted/039-metadata/metadata"
    metadata.mkdir(parents=True)
    selected = {
        key: sorted(names) for key, names in prep.RETAINED_SELECTION_NAMES.items()
    }
    prior = tmp_path / "prior.json"
    prior.write_text(json.dumps({"selected": selected}))
    monkeypatch.setattr(prep, "RETAINED_SELECTION_SHA256", prep.sha256(prior))
    groups = {
        "training": selected["train"] + [f"train-{i}.png" for i in range(97)],
        "validation": [f"val-{i}.png" for i in range(50)],
        "test": selected["test"] + [f"test-{i}.png" for i in range(47)],
    }
    pins = {}
    for key, names in groups.items():
        path = metadata / f"{key}.txt"
        path.write_text("\n".join(names) + "\n")
        pins[key] = prep.sha256(path)
    monkeypatch.setattr(prep, "OFFICIAL_039_PARTITION_SHA256", pins)
    return prior, metadata, groups


def test_historical_split_is_pinned_to_exact_authorized_names_and_identity(
    tmp_path, monkeypatch
):
    prior, _, _ = historical_split_fixture(tmp_path, monkeypatch)
    splits, exposed = prep.validated_039_partitions(tmp_path, prior)
    assert len(set(splits["test"]) - exposed) == 47
    prior.write_text(prior.read_text().replace("A06", "A07"))
    with pytest.raises(ValueError, match="authorized SHA-256"):
        prep.validated_039_partitions(tmp_path, prior)
    monkeypatch.setattr(prep, "RETAINED_SELECTION_SHA256", prep.sha256(prior))
    with pytest.raises(ValueError, match="authorized six fields"):
        prep.validated_039_partitions(tmp_path, prior)


@pytest.mark.parametrize("use_prior_selection", [False, True])
def test_historical_training_must_belong_to_training_even_if_partition_hash_is_replaced(
    tmp_path, monkeypatch, use_prior_selection
):
    prior, metadata, groups = historical_split_fixture(tmp_path, monkeypatch)
    groups["training"][0], groups["validation"][0] = (
        groups["validation"][0],
        groups["training"][0],
    )
    for key in ("training", "validation"):
        path = metadata / f"{key}.txt"
        path.write_text("\n".join(groups[key]) + "\n")
        prep.OFFICIAL_039_PARTITION_SHA256[key] = prep.sha256(path)
    with pytest.raises(ValueError, match="training exposure"):
        prep.validated_039_partitions(tmp_path, prior if use_prior_selection else None)


def test_public_split_replay_needs_no_historical_manifest_and_keeps_same_47_fields(
    tmp_path, monkeypatch
):
    prior, _, _ = historical_split_fixture(tmp_path, monkeypatch)
    historical = prep.validated_039_partitions(tmp_path, prior)
    prior.unlink()
    # Neither a private file nor its byte identity participates in public replay.
    monkeypatch.setattr(
        prep, "RETAINED_SELECTION_SHA256", "unavailable-private-identity"
    )
    public = prep.validated_039_partitions(tmp_path)
    assert public == historical
    assert public[1] == set.union(*prep.RETAINED_SELECTION_NAMES.values())
    assert len(set(public[0]["test"]) - public[1]) == 47


def test_public_split_replay_still_checks_exact_official_partition_bytes(
    tmp_path, monkeypatch
):
    prior, metadata, _ = historical_split_fixture(tmp_path, monkeypatch)
    prior.unlink()
    path = metadata / "test.txt"
    path.write_text(path.read_text() + "\n")
    with pytest.raises(ValueError, match="partition identity changed"):
        prep.validated_039_partitions(tmp_path)


@pytest.mark.parametrize("use_prior_selection", [False, True])
def test_prepare_039_records_explicit_public_or_historical_exposure_basis(
    tmp_path, monkeypatch, use_prior_selection
):
    prior, _, groups = historical_split_fixture(tmp_path, monkeypatch)
    if not use_prior_selection:
        prior.unlink()
    # Test adapter orchestration/provenance with synthetic IO only. Array shape,
    # dtype and round-trip assertions still execute; no dataset or masks exist.
    pixels = np.zeros((520, 696), dtype=np.uint16)
    images = tmp_path / "extracted/039-images/images"
    images.mkdir(parents=True)
    for names in groups.values():
        for name in names:
            (images / (Path(name).stem + ".tif")).write_bytes(b"synthetic-source")
    monkeypatch.setattr(prep.tifffile, "imread", lambda _path: pixels)
    monkeypatch.setattr(
        prep.tifffile,
        "imwrite",
        lambda path, *_args, **_kwargs: Path(path).write_bytes(b"synthetic-roundtrip"),
    )
    result = prep.prepare_039(tmp_path, prior if use_prior_selection else None)
    assert result["sealed_test_fields"] == 47
    assert len(result["images"]) == 200
    assert {
        record["reference_filename"]
        for record in result["images"]
        if record["role"] == "historically-exposed"
    } == set.union(*prep.RETAINED_SELECTION_NAMES.values())
    assert result["frozen_exposure_fields"] == {
        key: sorted(names) for key, names in prep.RETAINED_SELECTION_NAMES.items()
    }
    assert result["exposure_basis"] == (
        "exact-authorized-historical-selection-manifest"
        if use_prior_selection
        else "frozen-protocol-six-field-list"
    )
    assert result["prior_exposure_manifest"] == (
        prep.identity(prior) if use_prior_selection else None
    )


def test_prepare_039_cli_accepts_omitted_prior_selection(tmp_path, monkeypatch):
    import sys

    monkeypatch.setattr(
        sys, "argv", ["prepare", "prepare-039", "--data", str(tmp_path)]
    )
    calls = []
    monkeypatch.setattr(
        prep, "verify_manifest", lambda path: calls.append(("verify", path))
    )
    monkeypatch.setattr(
        prep, "prepare_039", lambda data, prior: {"data": str(data), "prior": prior}
    )
    monkeypatch.setattr(
        prep, "write_json", lambda path, value: calls.append(("write", path, value))
    )
    prep.main()
    assert calls == [
        ("verify", tmp_path / "source-manifest.json"),
        (
            "write",
            tmp_path / "prepared/BBBC039-manifest.json",
            {"data": str(tmp_path), "prior": None},
        ),
    ]


def qualification_fixture(tmp_path, monkeypatch):
    """Synthetic, independently pinned trust context; no retained outcomes/data."""

    def write_json(name, value):
        path = tmp_path / name
        path.write_text(json.dumps(value, sort_keys=True, allow_nan=False))
        return oracle.file_identity(path)

    raw = tmp_path / "field.tif"
    tifffile.imwrite(
        raw, np.arange(20, dtype=np.uint16).reshape(4, 5), metadata={"axes": "YX"}
    )
    reference = tmp_path / "field.png"
    Image.fromarray(np.zeros((4, 5, 3), dtype=np.uint8)).save(reference)
    originals = {}
    for key, file in (("039-images", raw), ("039-masks", reference)):
        archive = tmp_path / f"{key}.zip"
        with zipfile.ZipFile(archive, "w") as stream:
            stream.write(file, arcname=file.name)
        originals[key] = {
            "key": key,
            **oracle.file_identity(archive),
            "members": [{**oracle.file_identity(file), "archive_member": file.name}],
        }
    monkeypatch.setattr(
        oracle,
        "OFFICIAL_ARCHIVES",
        {"BBBC039v1": {key: record["sha256"] for key, record in originals.items()}},
    )
    source_manifest = write_json("sources.json", {"sources": [originals["039-images"]]})
    reference_manifest = write_json(
        "references.json", {"sources": [originals["039-masks"]]}
    )
    prepared = write_json(
        "prepared.json",
        {
            "images": [
                {
                    "reference_filename": "field.png",
                    "source": oracle.file_identity(raw),
                    "derived": oracle.file_identity(raw),
                    "axes": "YX",
                    "dtype": "uint16",
                    "shape": [4, 5],
                }
            ]
        },
    )
    protocol = tmp_path / "protocol.md"
    protocol.write_text("Synthetic protocol fixture; never a real qualification claim")
    monkeypatch.setattr(
        oracle, "PROTOCOL_SHA256", oracle.file_identity(protocol)["sha256"]
    )
    folder = tmp_path / "native"
    folder.mkdir()
    labels = np.zeros((4, 5), dtype=np.uint32)
    labels[1:3, 2] = 1
    np.save(folder / "labels.npy", labels, allow_pickle=False)
    tifffile.imwrite(
        folder / "labels.ome.tif", labels, ome=True, metadata={"axes": "YX"}
    )
    recipe = {
        "selection": {
            "c": 0,
            "z": 0,
            "t": 0,
            "level": 0,
            "x": 0,
            "y": 0,
            "width": 5,
            "height": 4,
        },
        "settings": {"threshold": 1},
        "measurement_channels": [0],
        "input_mapping": {"mode": "source-channel", "channel": 0},
        "profile_id": "synthetic-test",
    }
    runtime = {"backend": "synthetic-test"}
    recipe_file, runtime_file = (
        write_json("recipe.json", recipe),
        write_json("runtime.json", runtime),
    )
    app, worker = tmp_path / "app.asar", tmp_path / "worker"
    app.write_bytes(b"synthetic-app")
    worker.write_bytes(b"synthetic-worker")
    settings = {
        "schema": "loci.real-fluorescence.settings-freeze/v1",
        "dataset": "BBBC039v1",
        "raw_variant": "original",
        "protocol": oracle.file_identity(protocol),
        "source_manifest": source_manifest,
        "reference_manifest": reference_manifest,
        "prepared_manifest": prepared,
        "recipe": recipe_file,
        "runtime": runtime_file,
        "app": oracle.file_identity(app),
        "worker": oracle.file_identity(worker),
    }
    settings_file = write_json("settings.json", settings)
    source_sha = oracle.file_identity(raw)["sha256"]
    result = {
        "id": "synthetic-result",
        "revision_hash": "b" * 64,
        "source_id": "synthetic-source",
        "source_sha256": source_sha,
        "arrays": {
            "labels": {
                **{
                    k: v
                    for k, v in oracle.file_identity(folder / "labels.npy").items()
                    if k in ("sha256", "bytes")
                },
                "shape": [4, 5],
                "dtype": "uint32",
            }
        },
        "provenance": {
            "accepted_request": {**recipe, "source_id": "synthetic-source"},
            "runtime": runtime,
            "measurement_channels": [0],
            "measurement_basis": "raw-selected-channel-values-on-result-grid",
            "channel_metadata": {
                "source_id": "synthetic-source",
                "source_sha256": source_sha,
            },
        },
    }
    payload = {
        "result": result,
        "source": {
            "id": "synthetic-source",
            "sha256": source_sha,
            "identity_kind": "full-file-sha256",
            "size_bytes": raw.stat().st_size,
            "metadata": {
                "sha256": source_sha,
                "source_axes": "YX",
                "source_shape": [4, 5],
            },
        },
    }
    (folder / "result.json").write_text(json.dumps(payload))
    (folder / "loci-export.json").write_text(
        json.dumps(
            {
                "schema": "loci.export-marker/v1",
                "bundle_kind": "loci-export",
                "result_id": result["id"],
                "revision_hash": result["revision_hash"],
            }
        )
    )

    def refresh_manifest():
        files = [
            {
                "name": file.name,
                "sha256": oracle.file_identity(file)["sha256"],
                "size_bytes": file.stat().st_size,
            }
            for file in sorted(folder.iterdir())
            if file.name != "manifest.json"
        ]
        (folder / "manifest.json").write_text(
            json.dumps(
                {
                    "schema": "loci.export-manifest/v1",
                    "result_id": result["id"],
                    "revision_hash": result["revision_hash"],
                    "files": files,
                }
            )
        )
        return oracle.file_identity(folder / "manifest.json")["sha256"]

    run = {
        "schema": "loci.real-fluorescence.run-binding/v1",
        "settings_sha256": settings_file["sha256"],
        "source_key": "field.png",
        "source_sha256": source_sha,
        "result_id": result["id"],
        "revision_hash": result["revision_hash"],
        "export_manifest_sha256": refresh_manifest(),
        "labels_npy_sha256": oracle.file_identity(folder / "labels.npy")["sha256"],
        "labels_uint32le_sha256": hashlib.sha256(
            labels.astype("<u4").tobytes()
        ).hexdigest(),
        **{
            key + "_sha256": settings[key]["sha256"]
            for key in ("recipe", "runtime", "app", "worker")
        },
    }
    run_file = write_json("run.json", run)
    packet = {
        "schema": "loci.real-fluorescence.qualification-packet/v1",
        "settings_freeze": settings_file,
        "run_binding": run_file,
        "source_key": "field.png",
        "raw": oracle.file_identity(raw),
        "reference": oracle.file_identity(reference),
        "export_directory": str(folder),
    }
    return (
        packet,
        {
            "settings_sha256": settings_file["sha256"],
            "run_binding_sha256": run_file["sha256"],
        },
        payload,
        run,
        refresh_manifest,
        write_json,
    )


def test_qualification_binding_verifies_original_export_without_computing_outcomes(
    tmp_path, monkeypatch
):
    packet, trust, *_ = qualification_fixture(tmp_path, monkeypatch)
    result = oracle.validate_qualification_packet(packet, **trust)
    assert result["source_key"] == "field.png"
    assert (
        result["binding_status"]
        == "verified-inputs-only; no accuracy or biological qualification"
    )
    assert "instance_metrics" not in result


def test_qualification_rejects_same_shape_wrong_raw_and_self_attested_hash(
    tmp_path, monkeypatch
):
    packet, trust, *_ = qualification_fixture(tmp_path, monkeypatch)
    path = Path(packet["raw"]["path"])
    tifffile.imwrite(path, np.ones((4, 5), dtype=np.uint16), metadata={"axes": "YX"})
    packet["raw"] = oracle.file_identity(path)
    with pytest.raises(ValueError, match="trust pin"):
        oracle.validate_qualification_packet(packet, **trust)


@pytest.mark.parametrize("change", ["source", "revision", "recipe", "runtime"])
def test_qualification_rejects_stale_or_mismatched_native_provenance(
    tmp_path, monkeypatch, change
):
    packet, trust, payload, run, refresh, write_json = qualification_fixture(
        tmp_path, monkeypatch
    )
    result = payload["result"]
    if change == "source":
        result["source_sha256"] = "f" * 64
    elif change == "revision":
        run["revision_hash"] = "f" * 64
    elif change == "recipe":
        result["provenance"]["accepted_request"]["settings"]["threshold"] = 2
    else:
        result["provenance"]["runtime"]["backend"] = "wrong-runtime"
    Path(packet["export_directory"], "result.json").write_text(json.dumps(payload))
    run["export_manifest_sha256"] = refresh()
    packet["run_binding"] = write_json("run.json", run)
    trust["run_binding_sha256"] = packet["run_binding"]["sha256"]
    with pytest.raises(ValueError, match="fingerprint|stale|recipe/runtime"):
        oracle.validate_qualification_packet(packet, **trust)


def test_qualification_does_not_trust_packet_supplied_freeze_hash(
    tmp_path, monkeypatch
):
    packet, trust, _, run, _, write_json = qualification_fixture(tmp_path, monkeypatch)
    run["source_sha256"] = "f" * 64
    packet["run_binding"] = write_json("run.json", run)
    with pytest.raises(ValueError, match="independently supplied trust pin"):
        oracle.validate_qualification_packet(packet, **trust)


def test_bmp_scalar_preserves_8bit_and_refuses_false_colour(tmp_path):
    raw = np.arange(640 * 640, dtype=np.uint32).reshape(640, 640).astype(np.uint8)
    path = tmp_path / "raw.bmp"
    Image.fromarray(raw).save(path)
    assert np.array_equal(prep.scalar_bmp(path), raw)
    rgb = np.stack([raw, raw, raw], axis=2)
    rgb[0, 0, 1] = 99
    Image.fromarray(rgb).save(tmp_path / "colour.bmp")
    with pytest.raises(ValueError, match="channels differ"):
        prep.scalar_bmp(tmp_path / "colour.bmp")


def test_qualification_rejects_changed_candidate_and_wrong_reference_name(
    tmp_path, monkeypatch
):
    packet, trust, *_ = qualification_fixture(tmp_path, monkeypatch)
    alternate = tmp_path / "other-field.png"
    alternate.write_bytes(Path(packet["reference"]["path"]).read_bytes())
    packet["reference"] = oracle.file_identity(alternate)
    with pytest.raises(ValueError, match="Reference name/identity"):
        oracle.validate_qualification_packet(packet, **trust)
    packet["reference"] = oracle.file_identity(tmp_path / "field.png")
    (tmp_path / "app.asar").write_bytes(b"synthetic-bad")
    with pytest.raises(ValueError, match="Pinned file identity"):
        oracle.validate_qualification_packet(packet, **trust)


def test_qualification_rejects_disagreement_between_exported_label_formats(
    tmp_path, monkeypatch
):
    packet, trust, _, run, refresh, write_json = qualification_fixture(
        tmp_path, monkeypatch
    )
    tifffile.imwrite(
        Path(packet["export_directory"], "labels.ome.tif"),
        np.zeros((4, 5), dtype=np.uint32),
        ome=True,
        metadata={"axes": "YX"},
    )
    run["export_manifest_sha256"] = refresh()
    packet["run_binding"] = write_json("run.json", run)
    trust["run_binding_sha256"] = packet["run_binding"]["sha256"]
    with pytest.raises(ValueError, match="NPY and TIFF predictions differ"):
        oracle.validate_qualification_packet(packet, **trust)


def perinuclear_qualification_fixture(tmp_path, monkeypatch, *, zero_signal=False):
    """Miniature native child+optional parent; brute-force fixture masks, no Loci."""
    import copy
    import csv

    def write_json(name, value):
        path = tmp_path / name
        path.write_text(json.dumps(value, sort_keys=True, allow_nan=False))
        return oracle.file_identity(path)

    shape = (15, 16)
    gfp = (np.arange(np.prod(shape)).reshape(shape) % 91 + 1).astype(np.uint8)
    if zero_signal:
        gfp[:] = 0
    dna = np.flip(gfp, axis=0).copy() + np.uint8(2)
    originals = []
    for name, channel in (("A01-GFP.bmp", gfp), ("A01-DNA.bmp", dna)):
        path = tmp_path / name
        Image.fromarray(channel).save(path)
        originals.append(oracle.file_identity(path))
    raw = tmp_path / "A01.ome.tif"
    tifffile.imwrite(
        raw,
        np.stack([gfp, dna]),
        ome=True,
        metadata={"axes": "CYX"},
        photometric="minisblack",
    )
    reference = tmp_path / "Bioimage_CP2_Dose_WellMetadata_wortmannin.csv"
    reference.write_text(
        "Metadata_Well,Image_FileName_rawGFP,Image_FileName_rawDNA\nA01,A01-GFP.bmp,A01-DNA.bmp\n"
    )
    archives = {}
    for key, records in (
        ("013-bmp", originals),
        ("013-reproduction", [oracle.file_identity(reference)]),
    ):
        path = tmp_path / (key + ".zip")
        with zipfile.ZipFile(path, "w") as archive:
            for record in records:
                archive.write(record["path"], Path(record["path"]).name)
        archives[key] = {
            "key": key,
            **oracle.file_identity(path),
            "members": [
                {**record, "archive_member": Path(record["path"]).name}
                for record in records
            ],
        }
    monkeypatch.setattr(
        oracle,
        "OFFICIAL_ARCHIVES",
        {"BBBC013v1": {key: record["sha256"] for key, record in archives.items()}},
    )
    protocol = tmp_path / "protocol.md"
    protocol.write_text("Synthetic protocol only")
    monkeypatch.setattr(
        oracle, "PROTOCOL_SHA256", oracle.file_identity(protocol)["sha256"]
    )
    source_hash = oracle.file_identity(raw)["sha256"]
    source = {
        "id": "source",
        "sha256": source_hash,
        "size_bytes": raw.stat().st_size,
        "identity_kind": "full-file-sha256",
        "metadata": {
            "sha256": source_hash,
            "source_axes": "CYX",
            "source_shape": [2, *shape],
        },
    }
    metadata = {"source_id": "source", "source_sha256": source_hash}
    selection = {
        "c": 1,
        "z": 0,
        "t": 0,
        "level": 0,
        "x": 0,
        "y": 0,
        "width": shape[1],
        "height": shape[0],
    }
    recipe = {
        "selection": selection,
        "measurement_channels": [1],
        "input_mapping": {"mode": "source-channel", "channel": 1},
        "settings": {"threshold": 1},
        "profile_id": "miniature-adaptive",
    }
    geometry = {
        "axes": "YX",
        "unit": "pixel",
        "frame": "image",
        "affine": np.eye(4).tolist(),
    }
    runtime = {"backend": "miniature-test"}
    parent_provenance = {
        "accepted_request": {**recipe, "source_id": "source"},
        "measurement_channels": [1],
        "runtime": runtime,
        "measurement_basis": "raw-selected-channel-values-on-result-grid",
        "channel_metadata": metadata,
        "selection": selection,
        "geometry": geometry,
    }
    points = {2: (0, 2), 7: (4, 5), 42: (9, 11)}
    labels = np.zeros(shape, dtype=np.uint32)
    for label, point in points.items():
        labels[point] = label
    # Independent discrete enumeration, rather than the evaluator's EDT oracle.
    rings = np.zeros(shape, dtype=np.uint32)
    ambiguous = np.zeros(shape, dtype=np.uint8)
    for y in range(shape[0]):
        for x in range(shape[1]):
            if labels[y, x]:
                continue
            claims = [
                label
                for label, (ny, nx) in points.items()
                if (y - ny) ** 2 + (x - nx) ** 2 <= 25
            ]
            if len(claims) == 1:
                rings[y, x] = claims[0]
            ambiguous[y, x] = len(claims) > 1

    def object_rows(channel, ring_rows):
        rows = []
        for label, (y, x) in points.items():
            value = int(channel[y, x])
            row = {
                "label": label,
                "voxel_count": 1,
                "measure": 1.0,
                "measure_kind": "area",
                "measure_unit": "pixel^2",
                "centroid_index": [float(y), float(x)],
                "index_axes": "YX",
                "centroid_world_xyz": [float(x), float(y), 0.0],
                "world_frame": "image",
                "distance_unit": "pixel",
                "bbox_start": [y, x],
                "bbox_stop_exclusive": [y + 1, x + 1],
                "principal_rms_radii": [0.0, 0.0, 0.0],
                "touches_crop_border": y == 0,
                "nearest_centroid_distance": min(
                    float(np.hypot(y - oy, x - ox))
                    for other, (oy, ox) in points.items()
                    if other != label
                ),
                "intensity": {
                    f"source_channel_{0 if ring_rows else 1}": {
                        "sum": float(value),
                        "mean": float(value),
                        "min": float(value),
                        "max": float(value),
                        "std_population": 0.0,
                    }
                },
            }
            if ring_rows:
                values = channel[rings == label]
                total = int(values.sum(dtype=np.uint64))
                mean = total / len(values) if len(values) else None
                reasons = ["boundary-touching-nucleus"] if y == 0 else []
                reasons += (
                    ["empty-ring"]
                    if not len(values)
                    else ["zero-mean-ring"]
                    if total == 0
                    else []
                )
                row["perinuclear_ring"] = {
                    "count": len(values),
                    "sum": float(total),
                    "mean": mean,
                    "exclusions": reasons,
                    "nuclear_to_ring_mean_ratio": None if reasons else value / mean,
                }
            rows.append(row)
        return rows

    def write_csv(folder, rows):
        flat_rows = []
        for row in rows:
            flat = {}
            for key, value in row.items():
                if isinstance(value, dict):
                    for name, item in value.items():
                        if isinstance(item, dict):
                            flat.update(
                                {
                                    f"{key}:{name}:{stat}": number
                                    for stat, number in item.items()
                                }
                            )
                        else:
                            flat[f"{key}:{name}"] = item
                elif isinstance(value, list):
                    flat.update({f"{key}:{i}": item for i, item in enumerate(value)})
                else:
                    flat[key] = value
            flat_rows.append(flat)
        with (folder / "objects.csv").open("w", newline="") as stream:
            writer = csv.DictWriter(
                stream, fieldnames=sorted(flat_rows[0]), lineterminator="\n"
            )
            writer.writeheader()
            writer.writerows(flat_rows)

    def export(folder_name, result, arrays):
        folder = tmp_path / folder_name
        folder.mkdir()
        result["arrays"] = {}
        for name, array in arrays.items():
            np.save(folder / (name + ".npy"), array, allow_pickle=False)
            tifffile.imwrite(
                folder / (name + ".ome.tif"), array, ome=True, metadata={"axes": "YX"}
            )
            record = oracle.file_identity(folder / (name + ".npy"))
            result["arrays"][name] = {key: record[key] for key in ("sha256", "bytes")}
            result["arrays"][name].update(
                {"shape": list(array.shape), "dtype": str(array.dtype)}
            )
        payload = {"result": result, "source": copy.deepcopy(source)}

        def refresh():
            (folder / "result.json").write_text(json.dumps(payload))
            marker = {
                "schema": "loci.export-marker/v1",
                "bundle_kind": "loci-export",
                "result_id": result["id"],
                "revision_hash": result["revision_hash"],
            }
            (folder / "loci-export.json").write_text(json.dumps(marker))
            write_csv(folder, result["provenance"]["measurements"])
            files = [
                {
                    "name": file.name,
                    "sha256": oracle.file_identity(file)["sha256"],
                    "size_bytes": file.stat().st_size,
                }
                for file in sorted(folder.iterdir())
                if file.name != "manifest.json"
            ]
            manifest = {
                "schema": "loci.export-manifest/v1",
                "result_id": result["id"],
                "revision_hash": result["revision_hash"],
                "files": files,
            }
            (folder / "manifest.json").write_text(json.dumps(manifest))
            return oracle.file_identity(folder / "manifest.json")["sha256"]

        refresh()
        return folder, payload, refresh

    parent_provenance["measurements"] = object_rows(dna, False)
    parent = {
        "id": "parent",
        "revision_hash": "a" * 64,
        "source_id": "source",
        "source_sha256": source_hash,
        "kind": "adaptive-segmentation",
        "engine_version": "test",
        "provenance": parent_provenance,
    }
    parent_dir, parent_payload, parent_refresh = export(
        "parent", parent, {"image": dna.astype(np.float32), "labels": labels}
    )
    analysis = {
        "kind": parent["kind"],
        "engine_version": "test",
        "provenance": {
            key: copy.deepcopy(value)
            for key, value in parent_provenance.items()
            if key not in {"selection", "geometry", "measurements"}
        },
    }
    binding = {
        "result_id": parent["id"],
        "revision_hash": parent["revision_hash"],
        "source_id": "source",
        "source_sha256": source_hash,
        "arrays": copy.deepcopy(parent["arrays"]),
        "selection": copy.deepcopy(selection),
        "geometry": copy.deepcopy(geometry),
    }
    rows = object_rows(gfp, True)
    ratios = [
        row["perinuclear_ring"]["nuclear_to_ring_mean_ratio"]
        for row in rows
        if not row["perinuclear_ring"]["exclusions"]
    ]
    summary = {
        "object_count": 3,
        "eligible_count": len(ratios),
        "excluded_count": 3 - len(ratios),
        "excluded_by_reason": {
            reason: sum(reason in row["perinuclear_ring"]["exclusions"] for row in rows)
            for reason in oracle.PERINUCLEAR_REASONS
        },
        "endpoint_defined": bool(ratios),
        "median_ratio": float(np.median(ratios)) if ratios else None,
        "mean_ratio": float(np.mean(ratios)) if ratios else None,
    }
    request = {
        "signal_channel": 0,
        "radius_px": 5,
        "working_bytes": 1024**2,
        "control": "Fixed raw GFP ring proxy; synthetic test",
    }
    child = {
        "id": "child",
        "revision_hash": "b" * 64,
        "source_id": "source",
        "source_sha256": source_hash,
        "kind": "perinuclear-enrichment",
        "parent_id": "parent",
        "provenance": {
            "selection": {**selection, "c": 0},
            "geometry": geometry,
            "parent_result": binding,
            "nucleus_analysis": analysis,
            "measurement_channels": [0],
            "measurement_basis": "raw-selected-channel-values-on-result-grid",
            "channel_metadata": metadata,
            "runtime": runtime,
            "resource_guard": {"working_memory_limit_bytes": 1024**2},
            "measurements": rows,
            "perinuclear": {
                "schema": "loci.perinuclear-enrichment/v1",
                **oracle.PERINUCLEAR_RULES,
                "radius_px": 5,
                "signal_channel": 0,
                "control": request["control"],
                "summary": summary,
                "nucleus_result": {"result_id": "parent", "revision_hash": "a" * 64},
            },
        },
    }
    folder, payload, refresh = export(
        "child",
        child,
        {
            "image": gfp,
            "labels": labels,
            "ring_labels": rings,
            "ring_ambiguous": ambiguous,
        },
    )
    app, worker = tmp_path / "app.asar", tmp_path / "worker"
    app.write_bytes(b"synthetic-app")
    worker.write_bytes(b"synthetic-worker")
    settings = {
        "schema": "loci.real-fluorescence.settings-freeze/v1",
        "dataset": "BBBC013v1",
        "endpoint": oracle.PERINUCLEAR_ENDPOINT,
        "raw_variant": "prepared",
        "protocol": oracle.file_identity(protocol),
        "source_manifest": write_json(
            "sources.json", {"sources": [archives["013-bmp"]]}
        ),
        "reference_manifest": write_json(
            "references.json", {"sources": [archives["013-reproduction"]]}
        ),
        "prepared_manifest": write_json(
            "prepared.json",
            {
                "images": [
                    {
                        "well": "A01",
                        "sources": originals,
                        "derived": oracle.file_identity(raw),
                        "axes": "CYX",
                        "dtype": "uint8",
                        "shape": [2, *shape],
                    }
                ]
            },
        ),
        "app": oracle.file_identity(app),
        "worker": oracle.file_identity(worker),
    }
    for name, value in {
        "nucleus_recipe": recipe,
        "nucleus_runtime": runtime,
        "ring_request": request,
        "ring_rules": oracle.PERINUCLEAR_RULES,
        "ring_runtime": runtime,
    }.items():
        settings[name] = write_json(name + ".json", value)
    settings_file = write_json("settings.json", settings)
    run = {
        "schema": "loci.real-fluorescence.run-binding/v1",
        "settings_sha256": settings_file["sha256"],
        "endpoint": oracle.PERINUCLEAR_ENDPOINT,
        "source_key": "A01",
        "source_sha256": source_hash,
        "result_id": "child",
        "revision_hash": "b" * 64,
        "export_manifest_sha256": refresh(),
        "labels_npy_sha256": oracle.file_identity(folder / "labels.npy")["sha256"],
        "labels_uint32le_sha256": hashlib.sha256(
            labels.astype("<u4").tobytes()
        ).hexdigest(),
        "nucleus_analysis_sha256": oracle.canonical_sha256(analysis),
        "parent_result_sha256": oracle.canonical_sha256(binding),
        "nucleus_result": {"result_id": "parent", "revision_hash": "a" * 64},
        **{
            key + "_sha256": settings[key]["sha256"]
            for key in (
                "nucleus_recipe",
                "nucleus_runtime",
                "ring_request",
                "ring_rules",
                "ring_runtime",
                "app",
                "worker",
            )
        },
    }
    packet = {
        "schema": "loci.real-fluorescence.qualification-packet/v1",
        "settings_freeze": settings_file,
        "run_binding": write_json("run.json", run),
        "source_key": "A01",
        "raw": oracle.file_identity(raw),
        "reference": oracle.file_identity(reference),
        "export_directory": str(folder),
    }
    trust = {
        "settings_sha256": settings_file["sha256"],
        "run_binding_sha256": packet["run_binding"]["sha256"],
    }

    def repin():
        run["export_manifest_sha256"] = refresh()
        packet["run_binding"] = write_json("run.json", run)
        trust["run_binding_sha256"] = packet["run_binding"]["sha256"]

    return (
        packet,
        trust,
        payload,
        run,
        repin,
        write_json,
        parent_dir,
        parent_payload,
        parent_refresh,
    )


@pytest.mark.parametrize("zero_signal", [False, True])
def test_native_perinuclear_packet_checks_all_rows_masks_and_explicit_parent_gap(
    tmp_path, monkeypatch, zero_signal
):
    packet, trust, *_ = perinuclear_qualification_fixture(
        tmp_path, monkeypatch, zero_signal=zero_signal
    )
    result = oracle.validate_qualification_packet(packet, **trust)
    assert result["arithmetic_status"] == "verified-all-native-endpoint-rows-and-masks"
    assert result["parent_numeric_status"] == "not_checked_without_parent_export"
    assert "well_median_ratio" not in result


def test_native_perinuclear_parent_export_checks_DNA_rows(tmp_path, monkeypatch):
    packet, trust, _, run, repin, _, parent_dir, *_ = perinuclear_qualification_fixture(
        tmp_path, monkeypatch
    )
    packet["parent_export_directory"] = str(parent_dir)
    run["parent_export_manifest_sha256"] = oracle.file_identity(
        parent_dir / "manifest.json"
    )["sha256"]
    repin()
    result = oracle.validate_qualification_packet(packet, **trust)
    assert result["parent_numeric_status"] == "verified-DNA1-parent-rows-and-labels"


@pytest.mark.parametrize(
    "change",
    [
        "snapshot",
        "parent-grid",
        "label-binding",
        "nucleus-channel",
        "ring-radius",
        "ring-rule",
        "ring-channel",
        "ring-runtime",
        "sum",
        "centroid",
        "ratio",
        "exclusion",
        "summary",
    ],
)
def test_native_perinuclear_rejects_rehashed_adversarial_child(
    tmp_path, monkeypatch, change
):
    packet, trust, payload, run, repin, *_ = perinuclear_qualification_fixture(
        tmp_path, monkeypatch
    )
    provenance = payload["result"]["provenance"]
    if change == "snapshot":
        provenance["nucleus_analysis"]["engine_version"] = "other"
    elif change == "parent-grid":
        provenance["parent_result"]["selection"]["width"] -= 1
        run["parent_result_sha256"] = oracle.canonical_sha256(
            provenance["parent_result"]
        )
    elif change == "label-binding":
        provenance["parent_result"]["arrays"]["labels"]["sha256"] = "f" * 64
        run["parent_result_sha256"] = oracle.canonical_sha256(
            provenance["parent_result"]
        )
    elif change == "nucleus-channel":
        provenance["nucleus_analysis"]["provenance"]["accepted_request"][
            "input_mapping"
        ]["channel"] = 0
    elif change == "ring-radius":
        provenance["perinuclear"]["radius_px"] = 6
    elif change == "ring-rule":
        provenance["perinuclear"]["overlap_policy"] = "nearest wins"
    elif change == "ring-channel":
        provenance["selection"]["c"] = 1
    elif change == "ring-runtime":
        provenance["runtime"] = {"backend": "other"}
    elif change == "summary":
        provenance["perinuclear"]["summary"]["mean_ratio"] += 0.1
    elif change == "centroid":
        provenance["measurements"][1]["centroid_index"][0] += 0.01
    elif change == "sum":
        provenance["measurements"][1]["intensity"]["source_channel_0"]["sum"] += 1
    elif change == "ratio":
        provenance["measurements"][1]["perinuclear_ring"][
            "nuclear_to_ring_mean_ratio"
        ] += 0.1
    else:
        provenance["measurements"][0]["perinuclear_ring"]["exclusions"] = []
    repin()  # A rehashed bundle/run is still subject to frozen contract + oracle.
    with pytest.raises(ValueError):
        oracle.validate_qualification_packet(packet, **trust)


@pytest.mark.parametrize("name", ["image", "ring_labels", "ring_ambiguous"])
def test_native_perinuclear_rejects_rehashed_array_pixels(tmp_path, monkeypatch, name):
    packet, trust, payload, _, repin, *_ = perinuclear_qualification_fixture(
        tmp_path, monkeypatch
    )
    path = Path(packet["export_directory"]) / (name + ".npy")
    pixels = np.load(path, allow_pickle=False)
    pixels[1, 1] = pixels[1, 1] + 1
    np.save(path, pixels, allow_pickle=False)
    descriptor = payload["result"]["arrays"][name]
    identity = oracle.file_identity(path)
    descriptor.update({key: identity[key] for key in ("sha256", "bytes")})
    repin()
    with pytest.raises(ValueError, match="mask differs from oracle"):
        oracle.validate_qualification_packet(packet, **trust)


@pytest.mark.parametrize(
    "change", ["source", "revision", "DNA-sum", "labels", "pin-missing"]
)
def test_native_perinuclear_rejects_adversarial_parent_export(
    tmp_path, monkeypatch, change
):
    packet, trust, _, run, repin, _, parent_dir, payload, refresh = (
        perinuclear_qualification_fixture(tmp_path, monkeypatch)
    )
    packet["parent_export_directory"] = str(parent_dir)
    if change == "source":
        payload["source"]["sha256"] = "f" * 64
    elif change == "revision":
        payload["result"]["revision_hash"] = "f" * 64
    elif change == "DNA-sum":
        payload["result"]["provenance"]["measurements"][1]["intensity"][
            "source_channel_1"
        ]["sum"] += 1
    elif change == "labels":
        path = parent_dir / "labels.npy"
        pixels = np.load(path, allow_pickle=False)
        pixels[1, 1] = 99
        np.save(path, pixels, allow_pickle=False)
    if change != "pin-missing":
        run["parent_export_manifest_sha256"] = refresh()
    repin()
    with pytest.raises(ValueError):
        oracle.validate_qualification_packet(packet, **trust)


def test_native_perinuclear_freeze_and_run_remain_independent_pins(
    tmp_path, monkeypatch
):
    packet, trust, _, run, _, write_json, *_ = perinuclear_qualification_fixture(
        tmp_path, monkeypatch
    )
    run["nucleus_analysis_sha256"] = "f" * 64
    packet["run_binding"] = write_json("run.json", run)
    with pytest.raises(ValueError, match="independently supplied trust pin"):
        oracle.validate_qualification_packet(packet, **trust)


def test_native_endpoint_oracle_nontrivial_geometry_and_exact_integer_arithmetic():
    raw = np.arange(132, dtype=np.uint8).reshape(11, 12)
    labels = np.zeros(raw.shape, dtype=np.uint32)
    labels[3:5, 4:7] = 9
    summary, rows, rings, ambiguous = oracle._native_endpoint_oracle(raw, labels)
    row = rows[0]
    assert row["voxel_count"] == 6
    assert row["bbox_start"] == [3, 4]
    assert row["bbox_stop_exclusive"] == [5, 7]
    assert row["centroid_index"] == [3.5, 5.0]
    assert row["centroid_world_xyz"] == [5.0, 3.5, 0.0]
    assert row["principal_rms_radii"] == pytest.approx([np.sqrt(2 / 3), 0.5, 0])
    assert row["nearest_centroid_distance"] is None
    stats = row["intensity"]["source_channel_0"]
    assert stats["sum"] == 282
    assert stats["mean"] == 47
    assert stats["min"] == 40 and stats["max"] == 54
    assert stats["std_population"] == pytest.approx(np.sqrt(220 / 6))
    expected_ring = np.zeros(raw.shape, dtype=np.uint32)
    for y in range(raw.shape[0]):
        for x in range(raw.shape[1]):
            distance_squared = min(
                (y - ny) ** 2 + (x - nx) ** 2 for ny in (3, 4) for nx in (4, 5, 6)
            )
            if labels[y, x] == 0 and distance_squared <= 25:
                expected_ring[y, x] = 9
    assert np.array_equal(rings, expected_ring)
    assert not ambiguous.any()
    assert summary["endpoint_defined"] is True


def test_native_endpoint_oracle_preserves_empty_ring_and_boundary_exclusions():
    summary, rows, rings, ambiguous = oracle._native_endpoint_oracle(
        np.ones((3, 4), dtype=np.uint8), np.ones((3, 4), dtype=np.uint32)
    )
    ring = rows[0]["perinuclear_ring"]
    assert ring == {
        "count": 0,
        "sum": 0,
        "mean": None,
        "nuclear_to_ring_mean_ratio": None,
        "exclusions": ["boundary-touching-nucleus", "empty-ring"],
    }
    assert summary["median_ratio"] is None and summary["endpoint_defined"] is False
    assert summary["excluded_by_reason"]["empty-ring"] == 1
    assert not rings.any() and not ambiguous.any()


@pytest.mark.parametrize("change", ["CSV", "ring-TIFF", "missing-mask-entry"])
def test_native_endpoint_rejects_other_rehashed_native_exports(
    tmp_path, monkeypatch, change
):
    packet, trust, _, run, _, write_json, *_ = perinuclear_qualification_fixture(
        tmp_path, monkeypatch
    )
    folder = Path(packet["export_directory"])
    if change == "CSV":
        path = folder / "objects.csv"
        path.write_text(
            path.read_text().replace("source_channel_0", "source_channel_1")
        )
    elif change == "ring-TIFF":
        path = folder / "ring_labels.ome.tif"
        tifffile.imwrite(
            path, np.zeros((15, 16), dtype=np.uint32), ome=True, metadata={"axes": "YX"}
        )
    manifest = json.loads((folder / "manifest.json").read_text())
    for item in manifest["files"]:
        identity = oracle.file_identity(folder / item["name"])
        item.update({"sha256": identity["sha256"], "size_bytes": identity["bytes"]})
    if change == "missing-mask-entry":
        manifest["files"] = [
            item for item in manifest["files"] if item["name"] != "ring_ambiguous.npy"
        ]
    (folder / "manifest.json").write_text(json.dumps(manifest))
    run["export_manifest_sha256"] = oracle.file_identity(folder / "manifest.json")[
        "sha256"
    ]
    packet["run_binding"] = write_json("run.json", run)
    trust["run_binding_sha256"] = packet["run_binding"]["sha256"]
    with pytest.raises(ValueError, match="CSV|NPY/TIFF|pinned array"):
        oracle.validate_qualification_packet(packet, **trust)
