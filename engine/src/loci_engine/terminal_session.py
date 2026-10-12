"""Persistent terminal session over the existing CLI; no shell evaluation or new authority."""

from __future__ import annotations

import codecs
import io
import json
import os
import shlex
import signal
import subprocess
import sys
import time
from collections import deque
from contextlib import redirect_stderr, redirect_stdout, suppress
from typing import Any

from .terminal import _lines, _width, render, safe_text
from .terminal_identity import orbit_frame

_HINT = "help  /  discover  /  doctor     Ctrl-P pause motion  /  Ctrl-D exit"
_WELCOME = (
    "Local image research. Type a Loci command.",
    "Try: open cells.loci-study | objects --limit 5",
    "Up/Down: history. PgUp/PgDn: output.",
    "Ctrl-C: interrupt. Ctrl-P: pause motion.",
)
_LIMIT = 1000
_CHAR_LIMIT = 256 * 1024


class Transcript:
    """Bounded display history with wrapping cached between terminal updates."""

    def __init__(self) -> None:
        self.entries: deque[str] = deque()
        self.characters = 0
        self._columns = 0
        self._wrapped: list[str] | None = None

    def append(self, text: str) -> None:
        for start in range(0, max(1, len(text)), 4096):
            part = text[start : start + 4096]
            self.entries.append(part)
            self.characters += len(part)
            while len(self.entries) > _LIMIT or self.characters > _CHAR_LIMIT:
                self.characters -= len(self.entries.popleft())
        self._wrapped = None

    def clear(self) -> None:
        self.entries.clear()
        self.characters = 0
        self._wrapped = None

    def lines(self, columns: int) -> list[str]:
        if self._wrapped is None or columns != self._columns:
            self._wrapped = [part for entry in self.entries for part in _lines(entry, columns)]
            self._columns = columns
        return self._wrapped


def command_argv(line: str) -> list[str]:
    """Parse literal arguments only. A session cannot launch a transport or nested shell."""
    from .cli import _FORMAT_FLAGS, _INTERNAL, parser

    args = shlex.split(line)
    if args and args[0] == "loci":
        args.pop(0)
    remaining = [value for value in args if value not in _FORMAT_FLAGS]
    if not remaining:
        return ["--help"]
    if remaining[0] in {*_INTERNAL, "shell"}:
        raise ValueError("Run transport commands from your system shell, outside this session.")
    if any(value == "--request=-" for value in args) or (
        "--request" in args and args[args.index("--request") + 1 :][:1] == ["-"]
    ):
        raise ValueError("Use --request @file.json or explicit JSON in a session.")
    if remaining == ["help"]:
        args = ["--help"]
    if "--json" not in args and "--plain" not in args:
        args.insert(0, "--plain")
    # Resolve the same argparse aliases and repeated-option semantics as the child.
    # Invalid commands still go to its normal diagnostic path, but a valid alias
    # must not bypass the transport or stdin restrictions above.
    with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
        try:
            resolved = parser().parse_args(args)
        except SystemExit:
            return args
    if resolved.command in {*_INTERNAL, "shell"}:
        raise ValueError("Run transport commands from your system shell, outside this session.")
    if getattr(resolved, "request", None) == "-":
        raise ValueError("Use --request @file.json or explicit JSON in a session.")
    return args


class StudySession:
    """A successful child receipt pins state; failed/interrupted commands never do."""

    def __init__(self) -> None:
        self.opened: dict[str, Any] | None = None
        self.capture = False
        self.machine = False

    def prepare(self, line: str) -> list[str]:
        from .cli import parser

        self.capture = self.machine = False
        literal = shlex.split(line)
        if literal and literal[0] == "loci":
            literal.pop(0)
        if literal and literal[0] in {"select", "refresh"}:
            if self.opened is None:
                raise ValueError("Open a study first: open PATH.")
            if literal[0] == "select":
                if len(literal) != 2:
                    raise ValueError("Use select NUMBER or select RESULT_ID from the opened list.")
                choice = next(
                    (
                        item
                        for item in self.opened["choices"]
                        if literal[1] in {str(item["number"]), item["result_id"]}
                    ),
                    None,
                )
                if choice is None:
                    raise ValueError(
                        "Select a result from the opened list; open again to refresh its list."
                    )
                argv = [
                    "--json",
                    "open",
                    self.opened["project_path"],
                    "--result",
                    choice["result_id"],
                    "--revision",
                    choice["revision_hash"],
                ]
            else:
                if len(literal) != 1 or self.opened["selected"] is None:
                    raise ValueError("Select a result before using refresh with no arguments.")
                argv = [
                    "--json",
                    "open",
                    self.opened["project_path"],
                    "--result",
                    self.opened["selected"]["result_id"],
                ]
            self.capture = True
            return argv
        argv = command_argv(line)
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            try:
                args = parser().parse_args(argv)
            except SystemExit:
                return argv
        if args.command == "open":
            self.capture = True
            self.machine = getattr(args, "json", False)
            argv = ["--json", "open", args.path]
            for flag in ("result", "revision"):
                if getattr(args, flag) is not None:
                    argv.extend(["--" + flag, getattr(args, flag)])
        elif args.command in {"objects", "locate"} and args.project is None:
            if self.opened is None or self.opened["selected"] is None:
                raise ValueError("Open a study and select a measurable result first.")
            selected = self.opened["selected"]
            if args.result is not None or args.revision is not None:
                raise ValueError(
                    "Use select or refresh to change the binding, or supply --project explicitly."
                )
            argv.extend(
                [
                    "--project",
                    self.opened["project_path"],
                    "--result",
                    selected["result_id"],
                    "--revision",
                    selected["revision_hash"],
                ]
            )
        return argv

    def finish(self, text: str, returncode: int) -> str:
        if len(text) > _CHAR_LIMIT:
            return "Loci: Study receipt exceeds the session limit; binding unchanged.\n"
        if returncode:
            if self.machine:
                return text
            try:
                error = json.loads(text)["error"]["message"]
            except (ValueError, KeyError, TypeError):
                error = text
            return "Loci: " + safe_text(error) + "\n"
        try:
            receipt = json.loads(text)
            if receipt.get("schema") != "loci.cli-study/v1":
                raise ValueError("Unexpected study receipt")
            # Validate required fields before replacing the previous session state.
            for key in ("project_path", "choices", "selected", "study"):
                receipt[key]
            display = text if self.machine else render("open", receipt)
            if not self.machine and receipt["selected"] is not None:
                display += "Session binding: exact revision pinned.\n"
        except (ValueError, KeyError, TypeError) as exc:
            return "Loci: Invalid study receipt; binding unchanged: " + safe_text(exc) + "\n"
        self.opened = receipt
        return display


def _executable() -> list[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable, "--loci"]
    return [sys.executable, "-m", "loci_engine.cli"]


def _signal_child(process: subprocess.Popen[bytes], number: int) -> None:
    if process.poll() is None:
        with suppress(ProcessLookupError):
            os.killpg(process.pid, number)


def _stop_child(process: subprocess.Popen[bytes] | None) -> None:
    if process is None:
        return
    _signal_child(process, signal.SIGTERM)
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        _signal_child(process, signal.SIGKILL)
        process.wait(timeout=3)
    if process.stdout:
        process.stdout.close()


def _draw(
    screen: Any,
    elapsed: float,
    transcript: Transcript,
    line: str,
    cursor: int,
    status: str,
    paused: bool,
    scroll: int,
    color: int,
) -> None:
    import curses

    rows, columns = screen.getmaxyx()
    width = max(1, columns - 1)  # Never write into the bottom-right wrapping cell.
    screen.erase()

    def put(y: int, text: str, attr: int = 0) -> None:
        if 0 <= y < rows:
            # Slice by terminal cell width, including CJK and combining marks.
            clipped = _lines(text, width)[0]
            with suppress(curses.error):
                screen.addstr(y, 0, clipped, attr)

    if rows < 10 or columns < 24:
        put(0, "Loci session")
        put(1, "Enlarge terminal to view.")
        put(2, "Ctrl-D exits.")
        screen.refresh()
        return
    wrapped = transcript.lines(width)
    # The mark yields space to command results; output can use the remaining screen.
    minimum_hero = 6 if rows >= 18 else 1
    hero_height = min(23, max(minimum_hero, rows - max(11, len(wrapped) + 6)))
    hero = orbit_frame(elapsed, width, hero_height)
    for y, text in enumerate(hero):
        put(y, text, color | curses.A_BOLD)
        # The canonical central lens stays neutral against the colored petals.
        for x, character in enumerate(text):
            if character == "o":
                with suppress(curses.error):
                    screen.addstr(y, x, character, curses.A_BOLD)
    top = len(hero) + 1
    put(top, "Loci  /  " + status + ("  /  motion paused" if paused else ""), color)
    output_height = max(1, rows - top - 4)
    end = max(1, len(wrapped) - scroll)
    for offset, text in enumerate(wrapped[max(0, end - output_height) : end]):
        put(top + 1 + offset, text)
    hint = _HINT if width >= len(_HINT) else "help | Ctrl-P motion | Ctrl-D exit"
    if len(hint) > width:
        hint = "^P motion  ^D exit"
    put(rows - 2, hint)
    # Horizontally scroll the editable line so both cursor and complete input survive resize.
    visible_start = 0
    occupied = _width(line[:cursor])
    while occupied > max(1, width - 8):
        occupied -= _width(line[visible_start])
        visible_start += 1
    prompt = "loci> " if visible_start == 0 else "... > "
    put(rows - 1, prompt + line[visible_start:])
    with suppress(curses.error):
        screen.move(rows - 1, min(width - 1, len(prompt) + _width(line[visible_start:cursor])))
    screen.refresh()


def _session(screen: Any, interrupts: list[bool]) -> int:
    import curses

    screen.keypad(True)
    curses.raw()  # Handle Ctrl-C as input; external SIGINT uses the same cancellation route.
    screen.timeout(80)  # 12.5 fps; blocking keyboard wait, no busy spin.
    with suppress(curses.error):
        curses.curs_set(1)
    color = 0
    if curses.has_colors():
        curses.start_color()
        curses.use_default_colors()
        curses.init_pair(1, curses.COLOR_CYAN, -1)
        color = curses.color_pair(1)
    transcript = Transcript()
    for welcome in _WELCOME:
        transcript.append(welcome)
    history: deque[str] = deque(maxlen=100)
    history_index = 0
    draft = line = pending = ""
    cursor = scroll = 0
    status = "Ready"
    process: subprocess.Popen[bytes] | None = None
    study = StudySession()
    captured = ""
    capture_overflow = False
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    clock = started = time.monotonic()
    elapsed = 0.0
    paused = False
    dirty = True

    def append_output(text: str, *, final: bool = False) -> None:
        nonlocal pending, dirty
        pending += text
        lines = pending.split("\n")
        pending = lines.pop()
        for entry in lines:
            transcript.append(safe_text(entry.rstrip("\r")))
        # A producer may print a huge JSON line. Bound memory and retain visible chunks.
        while len(pending) > 8192:
            transcript.append(safe_text(pending[:8192]))
            pending = pending[8192:]
        if final and pending:
            transcript.append(safe_text(pending))
            pending = ""
        dirty = True

    try:
        while True:
            now = time.monotonic()
            if not paused:
                elapsed += now - clock
            clock = now
            if process is not None:
                assert process.stdout is not None
                # Read a bounded amount per frame, keeping keys/resize responsive during work.
                with suppress(BlockingIOError):
                    chunk = os.read(process.stdout.fileno(), 65536)
                    if chunk:
                        text = decoder.decode(chunk)
                        if study.capture:
                            if len(captured) + len(text) > _CHAR_LIMIT:
                                capture_overflow = True
                                _signal_child(process, signal.SIGTERM)
                            elif not capture_overflow:
                                captured += text
                        else:
                            append_output(text)
                    elif process.poll() is not None:
                        tail = decoder.decode(b"", final=True)
                        if study.capture:
                            text = (
                                "Loci: Study receipt too large; binding unchanged.\n"
                                if capture_overflow
                                else study.finish(captured + tail, process.returncode)
                            )
                            append_output(text, final=True)
                        else:
                            append_output(tail, final=True)
                        status = f"Exit {process.returncode}  /  {now - started:.1f}s"
                        process.stdout.close()
                        process = None
                        dirty = True
            if dirty or not paused:
                _draw(screen, elapsed, transcript, line, cursor, status, paused, scroll, color)
                dirty = False
            if interrupts[0]:
                interrupts[0] = False
                key = "\x03"
            else:
                try:
                    key = screen.get_wch()
                except curses.error:
                    continue
            dirty = True
            if key == "\x03":
                if process is not None:
                    _signal_child(process, signal.SIGINT)
                    status = "Interrupt requested"
                elif line:
                    line, cursor = "", 0
                else:
                    return 130
            elif key == "\x04":
                if process is not None:
                    _signal_child(process, signal.SIGINT)
                    status = "Interrupt requested; exit after the command ends"
                elif not line:
                    return 0
            elif key == "\x10":
                paused = not paused
            elif key == "\x0c":
                transcript.clear()
                scroll = 0
            elif key == curses.KEY_PPAGE:
                rows, columns = screen.getmaxyx()
                scroll = min(
                    max(0, len(transcript.lines(max(1, columns - 1))) - 1),
                    scroll + max(1, rows // 2),
                )
            elif key == curses.KEY_NPAGE:
                scroll = max(0, scroll - max(1, screen.getmaxyx()[0] // 2))
            elif key == curses.KEY_UP and history:
                if history_index == len(history):
                    draft = line
                history_index = max(0, history_index - 1)
                line = history[history_index]
                cursor = len(line)
            elif key == curses.KEY_DOWN and history:
                history_index = min(len(history), history_index + 1)
                line = history[history_index] if history_index < len(history) else draft
                cursor = len(line)
            elif key in (curses.KEY_LEFT, "\x02"):
                cursor = max(0, cursor - 1)
            elif key in (curses.KEY_RIGHT, "\x06"):
                cursor = min(len(line), cursor + 1)
            elif key in (curses.KEY_HOME, "\x01"):
                cursor = 0
            elif key in (curses.KEY_END, "\x05"):
                cursor = len(line)
            elif key in (curses.KEY_BACKSPACE, "\x7f", "\b") and cursor:
                line, cursor = line[: cursor - 1] + line[cursor:], cursor - 1
            elif key == curses.KEY_DC:
                line = line[:cursor] + line[cursor + 1 :]
            elif key == "\x15":
                line, cursor = line[cursor:], 0
            elif key in ("\n", "\r", curses.KEY_ENTER):
                if process is not None:
                    status = "Command still running; Ctrl-C interrupts"
                    continue
                submitted = line.strip()
                if submitted in {"exit", "quit", ":q"}:
                    return 0
                if not submitted:
                    continue
                history.append(submitted)
                history_index = len(history)
                transcript.append("loci> " + safe_text(submitted))
                line, cursor, scroll, draft = "", 0, 0, ""
                try:
                    argv = study.prepare(submitted)
                    captured, capture_overflow = "", False
                    process = subprocess.Popen(
                        [*_executable(), *argv],
                        stdin=subprocess.DEVNULL,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT,
                        start_new_session=True,
                    )
                    assert process.stdout is not None
                    os.set_blocking(process.stdout.fileno(), False)
                    decoder = codecs.getincrementaldecoder("utf-8")("replace")
                    started = time.monotonic()
                    status = "Running " + safe_text(submitted[:60])
                except (ValueError, OSError) as exc:
                    transcript.append(safe_text(exc))
                    status = "Command could not start"
                    _stop_child(process)
                    process = None
            elif isinstance(key, str) and key.isprintable() and len(line) < 8192:
                line = line[:cursor] + key + line[cursor:]
                cursor += len(key)
    finally:
        _stop_child(process)
        with suppress(curses.error):
            curses.noraw()


def run_session() -> int:
    """Own the terminal only for an explicitly interactive no-argument startup."""
    import curses
    import termios

    terminal_fd = sys.stdin.fileno()
    original_settings = termios.tcgetattr(terminal_fd)
    termination_signals = (signal.SIGTERM, signal.SIGHUP)
    previous = {number: signal.getsignal(number) for number in termination_signals}
    previous_interrupt = signal.getsignal(signal.SIGINT)
    interrupts = [False]

    def terminate(number: int, _frame: Any) -> None:
        raise SystemExit(128 + number)

    def interrupt(_number: int, _frame: Any) -> None:
        interrupts[0] = True

    for number in termination_signals:
        signal.signal(number, terminate)
    signal.signal(signal.SIGINT, interrupt)
    try:
        return int(curses.wrapper(_session, interrupts))
    except KeyboardInterrupt:
        return 130
    except curses.error as exc:
        print("Loci: " + safe_text(exc) + ". Use loci --plain for text help.", file=sys.stderr)
        return 1
    except SystemExit as exc:
        if exc.code in (129, 143):
            return int(exc.code)
        raise
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)
        signal.signal(signal.SIGINT, previous_interrupt)
        with suppress(termios.error):  # A terminal closed by SIGHUP no longer has settings.
            termios.tcsetattr(terminal_fd, termios.TCSANOW, original_settings)
        # Curses restores tty flags and the prior screen; make cursor recovery explicit.
        with suppress(OSError, ValueError):
            sys.stdout.write("\x1b[0m\x1b[?25h")
            sys.stdout.flush()
