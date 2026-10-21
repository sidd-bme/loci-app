"""Synthetic exact-ID CSV ingestion; no laboratory data or image reader needed."""

import copy
import csv
import hashlib
import io
import sqlite3

import pytest

import loci_engine.research_sample_sheet as sheet
from loci_engine.research_project import ResearchProject, canonical_json


@pytest.fixture
def fixture(tmp_path):
    project = ResearchProject.create(tmp_path / "study.loci-study", "Synthetic study")
    sources = []
    for index in range(2):
        path = tmp_path / f"raw-{index}.bin"
        path.write_bytes(f"synthetic immutable source {index}".encode())
        source = project.register_source(
            path, hashlib.sha256(path.read_bytes()).hexdigest(), {"axes": "YX"}
        )
        sources.append((path, source))
    return project, sources


def csv_text(project, sources, **overrides):
    stream = io.StringIO(newline="")
    writer = csv.writer(stream, lineterminator="\n")
    writer.writerow(sheet.COLUMNS)
    for index, (_, source) in enumerate(sources):
        data = dict(
            zip(
                sheet.COLUMNS,
                [
                    source["id"],
                    project.meta["title"],
                    f"sample {index}",
                    "control",
                    f"R{index}",
                    "",
                    "",
                ],
                strict=True,
            )
        )
        data.update(overrides)
        writer.writerow([data[field] for field in sheet.COLUMNS])
    return stream.getvalue()


def test_template_current_values_and_no_paths(fixture):
    project, sources = fixture
    template = sheet.template(project)
    rows = list(csv.DictReader(io.StringIO(template["csv_text"])))
    assert template["source_count"] == 2
    assert {r["source_id"] for r in rows} == {source["id"] for _, source in sources}
    assert all(r["sample"] == "" and r["study"] == project.meta["title"] for r in rows)
    assert str(project.root.parent) not in canonical_json(template)
    assert project.documents("sample") == []
    assert not sheet.preview(project, template["csv_text"])["can_apply"]
    sheet.apply(project, sheet.preview(project, csv_text(project, sources)))
    current = list(csv.DictReader(io.StringIO(sheet.template(project)["csv_text"])))
    assert {row["sample"] for row in current} == {"sample 0", "sample 1"}


def test_unicode_quoting_nulls_and_source_immutability(fixture):
    project, sources = fixture
    label = 'α, "quoted"\nsecond line\tβ'
    text = csv_text(project, sources, sample=label, condition="-signed", biological_replicate="")
    before = [path.read_bytes() for path, _ in sources]
    preview = sheet.preview(project, text)
    assert preview["can_apply"]
    assert all(
        r["before"] is None and r["after"]["biological_replicate"] is None for r in preview["rows"]
    )
    receipt = sheet.apply(project, preview)
    assert receipt["applied_count"] == 2
    assert all(
        d["data"]["sample"] == label and d["data"]["condition"] == "-signed"
        for d in receipt["documents"]
    )
    assert [path.read_bytes() for path, _ in sources] == before
    assert [d["revision"] for d in project.documents("sample")] == [1, 1]
    assert str(project.root.parent) not in canonical_json(preview)


@pytest.mark.parametrize("conflicting", [False, True])
def test_duplicate_rows_block_all_updates(fixture, conflicting):
    project, sources = fixture
    text = csv_text(project, sources[:1])
    duplicate = csv_text(project, sources[:1], condition="drug" if conflicting else "control")
    preview = sheet.preview(project, text + duplicate.split("\n", 1)[1])
    issue = "Conflicting duplicate source_id" if conflicting else "Duplicate source_id"
    assert not preview["can_apply"]
    assert all(issue in row["issues"] for row in preview["rows"])
    with pytest.raises(ValueError, match="validation failed"):
        sheet.apply(project, preview)
    assert project.documents("sample") == []


@pytest.mark.parametrize(
    "override,expected",
    [
        ({"source_id": "0" * 32}, "Unknown source_id"),
        ({"source_id": " raw-0.bin "}, "Unknown source_id"),
        ({"sample": ""}, "non-empty text"),
        ({"condition": " "}, "non-empty text"),
        ({"study": "Another study"}, "match the open study"),
        ({"biological_replicate": " "}, "non-empty text"),
        ({"well": "x" * 257}, "256 characters"),
        ({"sample": "bad\x00text"}, "control characters"),
    ],
)
def test_bad_row_blocks_every_change(fixture, override, expected):
    project, sources = fixture
    good = csv_text(project, sources[:1])
    bad = csv_text(project, sources[1:], **override)
    preview = sheet.preview(project, good + bad.split("\n", 1)[1])
    assert not preview["can_apply"]
    assert expected in " ".join(preview["rows"][1]["issues"])
    with pytest.raises(ValueError):
        sheet.apply(project, preview)
    assert project.documents("sample") == []


@pytest.mark.parametrize(
    "suffix",
    [
        None,
        "source_id,sample\nx,y\n",
        "",
        '"unterminated',
        'x,bare"quote,x,x,x,x,x\n',
        'x,"closed"trailing,x,x,x,x,x\n',
        "x,too,few\n",
        "x,too,many,fields,to,fit,this,row\n",
        "\n",
    ],
)
def test_malformed_csv_cannot_apply(fixture, suffix):
    project, _ = fixture
    text = "" if suffix is None else ",".join(sheet.COLUMNS) + "\n" + suffix
    preview = sheet.preview(project, text)
    assert not preview["can_apply"]
    with pytest.raises(ValueError):
        sheet.apply(project, preview)
    assert project.documents("sample") == []


def test_utf8_byte_and_row_limits(fixture):
    project, sources = fixture
    for bad in (b"not text", "\ud800", "α" * (sheet.MAX_CSV_BYTES // 2 + 1)):
        with pytest.raises(ValueError):
            sheet.preview(project, bad)
    row = csv_text(project, sources[:1]).split("\n", 1)[1]
    preview = sheet.preview(project, ",".join(sheet.COLUMNS) + "\n" + row * 1001)
    assert "1,000" in preview["errors"][0]
    assert project.documents("sample") == []


def test_stale_metadata_preserves_manual_edit(fixture):
    project, sources = fixture
    preview = sheet.preview(project, csv_text(project, sources))
    manual = project.put_document(
        "sample",
        sources[0][1]["id"],
        {"study": project.meta["title"], "sample": "manual", "condition": "drug"},
        expected_revision=0,
    )
    with pytest.raises(ValueError, match="stale"):
        sheet.apply(project, preview)
    assert project.documents("sample") == [manual]


def test_source_set_change_even_unselected_source_invalidates_preview(fixture, tmp_path):
    project, sources = fixture
    preview = sheet.preview(project, csv_text(project, sources[:1]))
    path = tmp_path / "new.bin"
    path.write_bytes(b"new synthetic source")
    project.register_source(path, hashlib.sha256(path.read_bytes()).hexdigest(), {})
    with pytest.raises(ValueError, match="stale"):
        sheet.apply(project, preview)
    assert project.documents("sample") == []


@pytest.mark.parametrize("symlink", [False, True])
def test_changed_or_symlink_source_bytes_fail_atomically(fixture, tmp_path, symlink):
    project, sources = fixture
    preview = sheet.preview(project, csv_text(project, sources))
    path = sources[1][0]
    if symlink:
        replacement = tmp_path / "replacement.bin"
        replacement.write_bytes(path.read_bytes())
        path.unlink()
        path.symlink_to(replacement)
    else:
        path.write_bytes(b"changed synthetic source")
    with pytest.raises(ValueError, match="source bytes"):
        sheet.apply(project, preview)
    assert project.documents("sample") == []


def test_other_project_and_mutated_identity_refused(fixture, tmp_path):
    project, sources = fixture
    preview = sheet.preview(project, csv_text(project, sources))
    other = ResearchProject.create(tmp_path / "other.loci-study", "Synthetic study")
    with pytest.raises(ValueError, match="stale"):
        sheet.apply(other, preview)
    with project.connection() as connection:
        meta = {**project.meta, "project_id": "f" * 32}
        connection.execute(
            "UPDATE metadata SET value=? WHERE key='project'", (canonical_json(meta),)
        )
    with pytest.raises(ValueError, match="project changed"):
        sheet.apply(project, preview)
    assert other.documents("sample") == []


@pytest.mark.parametrize("rehash", [False, True])
def test_preview_tampering_fails_even_with_recomputed_hash(fixture, rehash):
    project, sources = fixture
    preview = copy.deepcopy(sheet.preview(project, csv_text(project, sources)))
    preview["rows"][0]["after"]["condition"] = "forged"
    if rehash:
        preview["preview_sha256"] = hashlib.sha256(
            canonical_json({k: v for k, v in preview.items() if k != "preview_sha256"}).encode()
        ).hexdigest()
    with pytest.raises(ValueError):
        sheet.apply(project, preview)
    assert project.documents("sample") == []


def test_extra_keys_and_reapplication_rejected(fixture):
    project, sources = fixture
    preview = sheet.preview(project, csv_text(project, sources))
    with pytest.raises(ValueError, match="shape"):
        sheet.apply(project, {**preview, "unexpected": True})
    sheet.apply(project, preview)
    before = project.documents("sample")
    with pytest.raises(ValueError, match="stale"):
        sheet.apply(project, preview)
    assert project.documents("sample") == before


@pytest.mark.parametrize("failure", ["cancel", "write"])
def test_failure_after_first_insert_rolls_back_every_document(fixture, monkeypatch, failure):
    project, sources = fixture
    preview = sheet.preview(project, csv_text(project, sources))
    calls = []
    original_timestamp = sheet.timestamp

    def track_write():
        calls.append(True)
        if failure == "write" and len(calls) == 2:
            raise OSError("synthetic failure")
        return original_timestamp()

    def cancel():
        if failure == "cancel" and calls:
            raise RuntimeError("synthetic failure")

    monkeypatch.setattr(sheet, "timestamp", track_write)
    with pytest.raises((RuntimeError, OSError), match="synthetic failure"):
        sheet.apply(project, preview, publication_guard=cancel)
    assert len(calls) == (1 if failure == "cancel" else 2)
    assert project.documents("sample") == []


def test_apply_holds_write_lock_during_source_verification(fixture, monkeypatch):
    project, sources = fixture
    preview = sheet.preview(project, csv_text(project, sources))
    original_source = project.source
    attempts = []

    def checked_source(*args, **kwargs):
        with (
            sqlite3.connect(project.database, timeout=0) as competitor,
            pytest.raises(sqlite3.OperationalError, match="locked"),
        ):
            competitor.execute("BEGIN IMMEDIATE")
        attempts.append(True)
        return original_source(*args, **kwargs)

    monkeypatch.setattr(project, "source", checked_source)
    sheet.apply(project, preview)
    assert len(attempts) == 4
    assert len(project.documents("sample")) == 2


def test_source_edit_during_staged_publication_rolls_back(fixture, monkeypatch):
    project, sources = fixture
    preview = sheet.preview(project, csv_text(project, sources))
    original_timestamp = sheet.timestamp

    def change_source():
        sources[0][0].write_bytes(b"changed during publication")
        return original_timestamp()

    monkeypatch.setattr(sheet, "timestamp", change_source)
    with pytest.raises(ValueError, match="source bytes"):
        sheet.apply(project, preview)
    assert project.documents("sample") == []


def test_source_record_edit_invalidates_binding(fixture):
    project, sources = fixture
    preview = sheet.preview(project, csv_text(project, sources))
    source = project.source(sources[0][1]["id"])
    source["name"] = "Changed inspectable source label"
    with project.connection() as connection:
        connection.execute(
            "UPDATE sources SET record=? WHERE id=?", (canonical_json(source), source["id"])
        )
    with pytest.raises(ValueError, match="stale"):
        sheet.apply(project, preview)
    assert project.documents("sample") == []
