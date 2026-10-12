"""The session is a view/controller for exact CLI commands, never an operating shell."""

import math

import pytest

from loci_engine.terminal_identity import orbit_frame
from loci_engine.terminal_session import Transcript, command_argv


def test_commands_preserve_quotes_literal_metacharacters_and_exact_paths():
    assert command_argv('loci sources --project "/my study/data"') == [
        "--plain",
        "sources",
        "--project",
        "/my study/data",
    ]
    assert command_argv('create --title "$(touch /tmp/bad); `echo bad`" --project /tmp/a') == [
        "--plain",
        "create",
        "--title",
        "$(touch /tmp/bad); `echo bad`",
        "--project",
        "/tmp/a",
    ]
    assert command_argv("discover --json") == ["discover", "--json"]
    assert command_argv("help") == ["--plain", "--help"]


@pytest.mark.parametrize("line", ["mcp", "--json mcp", "loci remote-worker", "shell"])
def test_transport_and_nested_sessions_remain_outside_interactive_session(line):
    with pytest.raises(ValueError, match="outside this session"):
        command_argv(line)


def test_argparse_aliases_and_repeated_request_flags_cannot_bypass_session_rules():
    with pytest.raises(ValueError, match="outside this session"):
        command_argv("--pl remote-worker --request /abs")
    for options in ("--requ -", "--request '{}' --request -"):
        with pytest.raises(ValueError, match="@file.json"):
            command_argv("execute inspect --project /abs " + options)


@pytest.mark.parametrize("line", ["execute op --request -", "execute op --request=-"])
def test_stdin_payload_needs_a_file_or_literal_in_a_session(line):
    with pytest.raises(ValueError, match="@file.json"):
        command_argv(line)


def test_unclosed_quotes_are_not_executed():
    with pytest.raises(ValueError, match="quotation"):
        command_argv('create --title "unfinished')


def test_complete_and_partial_huge_output_is_bounded_and_wraps_once(monkeypatch):
    from loci_engine import terminal_session

    transcript = Transcript()
    for _ in range(200):
        transcript.append("12345678" * 1024)
    assert transcript.characters <= 256 * 1024
    assert len(transcript.entries) <= 1000
    assert max(map(len, transcript.entries)) <= 4096
    expected = transcript.lines(79)
    real_lines = terminal_session._lines
    monkeypatch.setattr(
        terminal_session, "_lines", lambda *_: pytest.fail("Rewrapped idle transcript")
    )
    for _ in range(50):
        assert transcript.lines(79) is expected
    monkeypatch.setattr(terminal_session, "_lines", real_lines)
    assert transcript.lines(39) is not expected
    transcript.append("new output")
    assert transcript.lines(39)[-1] == "new output"
    transcript.clear()
    assert transcript.lines(39) == [] and transcript.characters == 0


def test_long_input_scrolling_does_linear_width_work(monkeypatch):
    pytest.importorskip("curses", reason="POSIX terminal controller")
    from loci_engine import terminal_session

    class Screen:
        def getmaxyx(self):
            return 24, 80

        def erase(self):
            pass

        def addstr(self, *_):
            pass

        def move(self, *_):
            pass

        def refresh(self):
            pass

    measured = 0
    real_width = terminal_session._width

    def counting_width(value):
        nonlocal measured
        measured += len(value)
        return real_width(value)

    monkeypatch.setattr(terminal_session, "_width", counting_width)
    text = "組織e\u0301" * 2048
    terminal_session._draw(Screen(), 2, Transcript(), text, len(text), "Ready", True, 0, 0)
    assert measured <= len(text) * 3


@pytest.mark.parametrize("rows,columns", [(40, 100), (24, 80), (18, 46)])
def test_long_command_output_gets_screen_space_and_remains_scrollable(rows, columns):
    pytest.importorskip("curses", reason="POSIX terminal controller")
    from loci_engine import terminal_session

    class Screen:
        def __init__(self):
            self.lines = {}

        def getmaxyx(self):
            return rows, columns

        def erase(self):
            self.lines.clear()

        def addstr(self, y, x, text, *_):
            if x == 0:
                self.lines[y] = text

        def move(self, *_):
            pass

        def refresh(self):
            pass

    transcript = Transcript()
    for index in range(60):
        transcript.append(f"Measurement {index}")
    screen = Screen()
    terminal_session._draw(screen, 3, transcript, "", 0, "Exit 0", True, 0, 0)
    shown = [text for text in screen.lines.values() if text.startswith("Measurement")]
    assert len(shown) >= rows - 12
    assert shown[-1] == "Measurement 59"
    assert all(len(text) < columns for text in screen.lines.values())
    terminal_session._draw(screen, 3, transcript, "", 0, "Exit 0", True, 30, 0)
    shown = [text for text in screen.lines.values() if text.startswith("Measurement")]
    assert shown[-1] == "Measurement 29"


@pytest.mark.parametrize("mode", ["interrupt", "hangup"])
def test_running_child_is_interrupted_or_terminated_on_session_exit(monkeypatch, tmp_path, mode):
    curses = pytest.importorskip("curses", reason="POSIX terminal controller")
    import os
    import sys
    import time

    from loci_engine import terminal_session

    ready, stopped = tmp_path / "ready", tmp_path / "stopped"
    child = f"""
import os, signal, time
from pathlib import Path
def stop(number, frame):
    Path({str(stopped)!r}).write_text(str(number))
    raise SystemExit(128 + number)
signal.signal(signal.SIGINT, stop)
signal.signal(signal.SIGTERM, stop)
Path({str(ready)!r}).write_text(str(os.getpid()))
while True:
    time.sleep(.01)
"""
    status = [""]
    keys = iter("doctor\r")
    deadline = time.monotonic() + 5

    class Screen:
        cancelled = False

        def keypad(self, *_):
            pass

        def timeout(self, *_):
            pass

        def get_wch(self):
            key = next(keys, None)
            if key is not None:
                return key
            assert time.monotonic() < deadline, "Session did not reap the interrupted child"
            if ready.exists() and not self.cancelled:
                self.cancelled = True
                if mode == "hangup":
                    raise SystemExit(129)
                return "\x03"
            if status[0].startswith("Exit 130"):
                return "\x04"
            time.sleep(0.005)
            raise curses.error()

    monkeypatch.setattr(terminal_session, "_executable", lambda: [sys.executable, "-c", child])
    monkeypatch.setattr(terminal_session, "_draw", lambda *args: status.__setitem__(0, args[5]))
    for name in ("raw", "noraw", "curs_set"):
        monkeypatch.setattr(curses, name, lambda *_: None)
    monkeypatch.setattr(curses, "has_colors", lambda: False)
    if mode == "hangup":
        with pytest.raises(SystemExit) as result:
            terminal_session._session(Screen(), [False])
        assert result.value.code == 129
        assert stopped.read_text() == "15"
    else:
        assert terminal_session._session(Screen(), [False]) == 0
        assert stopped.read_text() == "2"
    with pytest.raises(ProcessLookupError):
        os.kill(int(ready.read_text()), 0)


@pytest.mark.parametrize("width,height", [(1, 1), (23, 9), (40, 13), (80, 18), (120, 25)])
def test_procedural_orbits_stay_inside_resized_terminal(width, height):
    for elapsed in (0, 1.2, 3, 6, 12, 12000):
        frame = orbit_frame(elapsed, width, height)
        assert len(frame) <= height
        assert all(len(row) <= width for row in frame)
        assert all(ord(char) < 128 for row in frame for char in row)
    assert orbit_frame(3, width, height) == orbit_frame(15, width, height)


def test_particles_form_petals_once_before_live_motion():
    frames = [orbit_frame(seconds, 100, 23) for seconds in (0, 0.5, 1.3, 2.4)]
    assert len({"\n".join(frame) for frame in frames}) == 4
    assert not any("#" in row for row in frames[0])
    assert any("#" in row for row in frames[-1])
    assert any("o" in row for row in frames[-1])
    assert all(frame[-4:] == frames[0][-4:] for frame in frames)


def test_orbits_keep_moving_after_startup_and_wordmark_stays_fixed():
    frames = [orbit_frame(seconds) for seconds in (5, 6, 8, 16, 19)]
    assert len({"\n".join(frame[:-1]) for frame in frames}) == len(frames)
    assert all(frame[-1] == frames[0][-1] for frame in frames)
    for value in (math.nan, math.inf, -math.inf):
        with pytest.raises(ValueError):
            orbit_frame(value)
