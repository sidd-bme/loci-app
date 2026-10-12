import io
import signal
import time

import pytest

from loci_engine.terminal import WorkIndicator, render, safe_text, table


def test_controls_newlines_osc_and_directional_text_are_visible_but_inert():
    original = "source\n\r\t\x00\x1b]52;c;secret\x07\x7f\x85\u202esuffix"
    cleaned = safe_text(original)
    assert cleaned.startswith("source\\x0a\\x0d\\x09\\x00\\x1b]52;")
    assert "\\u202e" in cleaned
    assert not any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in cleaned)
    assert original.endswith("\u202esuffix")


@pytest.mark.parametrize("width", [20, 35, 59, 60, 80])
def test_narrow_tables_wrap_without_losing_ids_or_precision(width):
    identity = "a" * 32
    precise = "-0.12345678901234567"
    text = table(["ID", "Measurement", "Scope"], [[identity, precise, "explicit ZYX"]], width)
    assert all(len(line) <= width for line in text.splitlines())
    assert identity in text.replace("\n", "")
    assert precise in text.replace("\n", "").replace(" ", "")


def test_human_jobs_retain_errors_and_actionable_ids_with_hashes_in_json_only():
    text = render(
        "run",
        {
            "job": {
                "id": "a" * 32,
                "operation": "run_recipe",
                "state": "failed",
                "result_ids": [],
                "error": "Budget refused\nNo result published",
            },
            "result": {"id": "b" * 32, "revision_hash": "c" * 64, "object_count": 2},
        },
        80,
    )
    assert "failed" in text and "Job error: Budget refused\\x0aNo result published" in text
    assert "b" * 32 in text
    assert "c" * 64 not in text.replace("\n", "").replace(" ", "")
    assert "--json shows the complete receipt." in text


def test_generic_nested_metadata_keeps_review_security_errors_and_exact_numbers():
    from loci_engine.cli import _json

    output = {
        "result": {
            "id": "a" * 32,
            "revision_hash": "b" * 64,
            "review": {"disposition": "pending", "revision_hash": "b" * 64},
        },
        "source_sha256": "c" * 64,
        "settings": {"sha256": "d" * 64, "threshold": -0.12345678901234567},
        "review_stale": True,
        "security": {"allow_export": False, "warnings": [{"message": "Denied\x1b[2J"}]},
    }
    before = _json(output)
    text = render("execute", output, 80)
    assert _json(output) == before
    assert all(digit * 64 not in text for digit in "bcd")
    assert "review / disposition: pending" in text and "review_stale: True" in text
    assert "security / allow_export: False" in text and "Denied\\x1b[2J" in text
    assert "threshold: -0.12345678901234566" in text
    assert "{" not in text and "\x1b" not in text


@pytest.mark.parametrize("width", [1, 2, 12, 20, 40, 80, 160])
def test_population_text_accounts_for_units_filters_missing_sampling_and_exact_json(width):
    from loci_engine.cli import _json
    from loci_engine.research_population import query_population

    rows = [
        {
            "label": index + 1,
            "voxel_count": 1,
            "measure": None if index == 0 else index / 7,
            "measure_kind": "area",
            "measure_unit": "um^2",
            "distance_unit": "um",
            "centroid_index": [0, 0],
            "index_axes": "YX",
            "bbox_start": [0, 0],
            "bbox_stop_exclusive": [1, 1],
            "intensity": {"組織\x1b[2J\u202e": {"mean": None if index == 1 else 7 - index}},
        }
        for index in range(8)
    ]
    output = query_population(
        rows,
        {"filters": [{"metric": "measure", "min": 0.1}], "plot_limit": 2, "selected_label": 1},
        {"result_id": "a" * 32, "revision_hash": "b" * 64, "source_sha256": "c" * 64},
    )
    before = _json(output)
    text = render("execute", output, width)
    from loci_engine.terminal import _width

    assert all(_width(line) <= width for line in text.splitlines())
    assert _json(output) == before
    assert not any(char in text for char in ("\x1b", "\u202e", "—", "•"))
    joined = text.replace("\n", "")
    for expected in (
        "Objects: 7 of 8 after filters",
        "Excluded: 1; missing filter values: 1",
        "Filter: Area (um^2); min=0.1",
        "Finite: 7; missing: 0",
        "Finite: 6; missing: 1",
        "Scatter: 2 of 6 finite pairs; missing pairs: 1",
        "Sampling: deterministic-evenly-spaced-label-order",
        "Objects shown: 5 of 7 returned; offset: 0",
        "Selected label: 1; outside filters",
        "6 significant digits",
    ):
        assert expected in joined
    assert "b" * 64 not in joined and "c" * 64 not in joined


def test_empty_population_displays_missing_values_without_inventing_zero():
    from loci_engine.research_population import query_population

    output = query_population([], {}, {"result_id": "a" * 32})
    text = render("execute", output, 80)
    assert "Objects: 0 of 0" in text and "Objects shown: 0 of 0" in text
    assert "Mean: 0" not in text and "Median: 0" not in text


def test_population_integer_pixel_counts_remain_exact_at_numeric_limit():
    from loci_engine.research_population import query_population

    count = 2**53
    output = query_population(
        [
            {
                "label": 1,
                "voxel_count": count,
                "measure": 0.12345678901234567,
                "measure_kind": "area",
                "measure_unit": "um^2",
                "distance_unit": "um",
                "centroid_index": [0, 0],
                "index_axes": "YX",
                "bbox_start": [0, 0],
                "bbox_stop_exclusive": [count, 1],
                "intensity": {},
            }
        ],
        {"x_metric": "voxel_count", "y_metric": "measure"},
        {"result_id": "a" * 32},
    )
    text = render("execute", output, 80)
    assert f"Min: {count}" in text.replace("\n", "")
    assert f"Max: {count}" in text.replace("\n", "")
    assert str(count) in text.split("Objects shown:")[1]
    assert "Mean: 0.123457" in text


@pytest.mark.parametrize("point,axes", [([123, 456], "YX"), ([7, 123, 456], "ZYX")])
def test_location_uses_exact_zero_based_result_grid_axes(point, axes):
    output = {
        "result_id": "a" * 32,
        "revision_hash": "b" * 64,
        "label": 90000,
        "point_index": point,
    }
    text = render("execute", output, 80)
    assert "Label: 90000" in text and "Result-grid index (zero-based):" in text
    assert ", ".join(f"{axis}={value}" for axis, value in zip(axes, point, strict=True)) in text
    assert "records" not in text and "b" * 64 not in text


def test_indicator_only_runs_during_work_and_cleans_after_exception():
    stream = io.StringIO()
    with (
        pytest.raises(ValueError),
        WorkIndicator(stream, "running", True, delay=0.01, interval=0.02),
    ):
        time.sleep(0.06)
        raise ValueError("real execution error")
    assert "Loci (o . .) running" in stream.getvalue()
    assert stream.getvalue().endswith("\r\x1b[2K")
    before = stream.getvalue()
    time.sleep(0.04)
    assert stream.getvalue() == before


def test_fast_and_disabled_work_never_produces_motion():
    for enabled in (True, False):
        stream = io.StringIO()
        with WorkIndicator(stream, "validating", enabled, delay=1):
            pass
        assert stream.getvalue() == ""


def test_sigterm_handler_clears_motion_and_restores_previous_handler():
    previous = signal.getsignal(signal.SIGTERM)
    stream = io.StringIO()
    with (
        pytest.raises(SystemExit) as stopped,
        WorkIndicator(stream, "running", True, delay=0.01, interval=0.02) as work,
    ):
        time.sleep(0.03)
        work._terminate(signal.SIGTERM, None)
    assert stopped.value.code == 143
    assert stream.getvalue().endswith("\r\x1b[2K")
    assert signal.getsignal(signal.SIGTERM) is previous


def test_untrusted_titles_render_safely_without_changing_json_values():
    import json

    title = "Research\n\x1b]0;owned\x07\u202eexperiment\x7f"
    assert title == json.loads(json.dumps({"title": title}))["title"]
    human = render("snapshot", {"project": {"title": title}}, 30)
    assert "\x1b" not in human and "\u202e" not in human and "\x7f" not in human
    assert "\\x1b" in human and "\\u202e" in human


def test_unicode_table_uses_terminal_columns_for_cjk_and_combining_marks():
    import unicodedata

    text = table(["Name", "ID"], [["組織" * 30 + "e\u0301", "a" * 32]], 60)
    for line in text.splitlines():
        columns = sum(
            0
            if unicodedata.combining(char)
            else 2
            if unicodedata.east_asian_width(char) in {"W", "F"}
            else 1
            for char in line
        )
        assert columns <= 60
    assert "組織" * 30 + "e\u0301" in text.replace("\n", "").replace(" ", "")


def test_procedural_identity_settles_to_three_nodes_and_ascii_wordmark():
    from loci_engine.terminal_identity import logo_frame

    settled = logo_frame()
    assert settled.count("( o )") == 3
    assert "LLLLL   OOO    CCC   III" in settled
    assert "LOCAL IMAGE RESEARCH" in settled
    assert all(ord(character) < 128 for character in settled)
    assert logo_frame(0.1) != logo_frame(0.5) != settled
    for width in (20, 40, 58, 70, 100):
        assert all(len(line) <= width for line in logo_frame(width=width).splitlines())


@pytest.mark.parametrize("interrupt", [KeyboardInterrupt, SystemExit])
def test_identity_always_restores_cursor_and_sigterm_after_interrupt(monkeypatch, interrupt):
    from loci_engine import terminal_identity

    previous = signal.getsignal(signal.SIGTERM)
    stream = io.StringIO()

    def stopped(_duration):
        raise interrupt()

    monkeypatch.setattr(terminal_identity.time, "sleep", stopped)
    monkeypatch.setattr(
        terminal_identity.shutil,
        "get_terminal_size",
        lambda _fallback: type("Size", (), {"columns": 80, "lines": 24})(),
    )
    with pytest.raises(interrupt):
        terminal_identity.animate_logo(stream, 0.2)
    assert "\x1b[?25l" in stream.getvalue()
    assert stream.getvalue().endswith("\x1b[0m\x1b[?25h")
    assert signal.getsignal(signal.SIGTERM) is previous


@pytest.mark.parametrize("width", [20, 35, 45, 80])
def test_operation_human_route_is_complete_and_shell_copyable(width):
    import shlex

    from loci_engine.cli_support import operation

    detail = operation("large_components_preflight")
    human = render("operation", detail, width)
    command = human.split("Invocation:\n", 1)[1].split("\n\n", 1)[0]
    assert shlex.split(command.replace("\\\n", "")) == detail["argv"]


def test_short_terminal_logo_uses_static_frame_without_controls_or_wait(monkeypatch):
    from loci_engine import terminal_identity

    monkeypatch.setattr(
        terminal_identity.shutil,
        "get_terminal_size",
        lambda _fallback: type("Size", (), {"columns": 80, "lines": 10})(),
    )
    monkeypatch.setattr(
        terminal_identity.time, "sleep", lambda _duration: pytest.fail("Startup delay")
    )
    stream = io.StringIO()
    terminal_identity.animate_logo(stream, 8)
    assert "\x1b" not in stream.getvalue()
    assert "LLLLL   OOO    CCC   III" in stream.getvalue()
