"""Procedural three-node identities; never scientific data or a progress indicator."""

from __future__ import annotations

import math
import shutil
import signal
import threading
import time
from contextlib import suppress
from typing import Any, TextIO

_WORDMARK = (
    "L       OOO    CCC   III",
    "L      O   O  C      I ",
    "L      O   O  C      I ",
    "LLLLL   OOO    CCC   III",
)

_SOLID_WORDMARK = (
    "@@       @@@@    @@@@  @@@@@@",
    "@@      @@  @@  @@       @@  ",
    "@@      @@  @@  @@       @@  ",
    "@@@@@@   @@@@    @@@@  @@@@@@",
)


# 48 px bit mask sampled from desktop/assets/loci-mark-128.png. Its SHA-256 is
# 6f64e15f3e84cade4551699d8dbf2f1fad11a27a147bf56507fd4cd4c4b5cbb3.
# Keeping the canonical silhouette here avoids importing an image backend at startup.
_PETALS = (
    0x000000000000,
    0x000000000000,
    0x000000000000,
    0x000000000000,
    0x000000000000,
    0x000000000000,
    0x000000000000,
    0x0000FC3E0000,
    0x0001FE7F8000,
    0x0007FE7FC000,
    0x0007FEFFF000,
    0x000FFEFFF800,
    0x003FFEFFF800,
    0x003FFEFFFC00,
    0x007FFEFFFE00,
    0x007FFEFFFE00,
    0x00FFFEFFFF00,
    0x00FFFEFFFF00,
    0x01FFFEFFFF80,
    0x01FFFCFFFF80,
    0x01FFFC7FFF80,
    0x01FFF83FFF80,
    0x01FFF01FFF80,
    0x01FFF01FFF80,
    0x01FFF01FFF80,
    0x01FFE01FFF80,
    0x01FFE00FFF80,
    0x01FFC007FF80,
    0x00FF8C73FF00,
    0x00FE3FFCFF00,
    0x0078FFFF1C00,
    0x0003FFFFC000,
    0x0007FFFFE000,
    0x000FFFFFF000,
    0x000FFFFFF000,
    0x0007FFFFF000,
    0x0007FFFFE000,
    0x0003FFFFC000,
    0x0001FFFF8000,
    0x00007FFE0000,
    0x00001FF80000,
    0x000000000000,
    0x000000000000,
    0x000000000000,
    0x000000000000,
    0x000000000000,
    0x000000000000,
    0x000000000000,
)


def _petal(x: float, y: float) -> bool:
    px, py = round(23.5 + x * 17), round(23.5 + y * 17)
    return 0 <= px < 48 and 0 <= py < 48 and bool(_PETALS[py] & (1 << px))


def orbit_frame(seconds: float = 0.0, width: int = 80, height: int = 18) -> list[str]:
    """Particles form the canonical petals, then pulse with two orbiting points.

    The one-time 2.4 s entrance never blocks input. Live motion repeats every 12 s.
    Rendering is bounded, ASCII-only, and independent of scientific/image backends.
    Terminal cells are treated as approximately twice as tall as they are wide.
    Lowercase `o` marks the central lens for the terminal's neutral foreground.
    """
    if not math.isfinite(seconds):
        raise ValueError("Animation time must be finite.")
    width, height = max(1, min(width, 160)), max(1, min(height, 32))
    seconds = max(0, seconds)
    if height < 6 or width < 24:
        dots = (".  ", " . ", "  .", " . ")
        return [("Loci  " + dots[int(seconds * 2) % 4])[:width].center(width)]
    wordmark = _SOLID_WORDMARK if height >= 19 and width >= 40 else ("L o c i",)
    canvas_height = height - len(wordmark) - 1
    canvas = [[" " for _ in range(width)] for _ in range(canvas_height)]
    cx, cy = (width - 1) / 2, (canvas_height - 1) / 2
    radius = min((canvas_height - 1) / 2.4, (width - 3) / 4.8)
    phase = ((max(0, seconds - 2.4) % 12) / 12) * math.tau
    pulse = 1 + 0.025 * math.sin(phase * 2)

    def put(x: float, y: float, character: str) -> None:
        px, py = round(cx + x * radius * 2), round(cy + y * radius)
        if 0 <= px < width and 0 <= py < canvas_height:
            canvas[py][px] = character

    if seconds < 1.0:
        # Small points expand into an enclosing circle with a soft landing.
        spread = 0.12 + 1.01 * (1 - (1 - min(seconds, 1)) ** 3)
        for point in range(40):
            angle = point * math.tau / 40
            put(math.cos(angle) * spread, math.sin(angle) * spread, ".")
        put(0, 0, "o")
    else:
        fill = min(1, max(0, (seconds - 1.55) / 0.85))
        density = ".:=+*#@"
        for row in range(canvas_height):
            for col in range(width):
                x, y = (col - cx) / (radius * 2 * pulse), (row - cy) / (radius * pulse)
                # Open the canonical seams by one optical step so they remain
                # distinguishable when several source pixels share an ASCII cell.
                if (
                    (abs(x) < 0.08 and y < -0.14)
                    or (y > 0 and abs(y - (abs(x) * 0.65 + 0.03)) < 0.09)
                    or math.hypot(x, y) < 0.22
                ):
                    continue
                coverage = (
                    sum(
                        _petal(x + dx / (radius * 2), y + dy / radius)
                        for dx, dy in ((-0.3, -0.3), (0.3, -0.3), (-0.3, 0.3), (0.3, 0.3))
                    )
                    / 4
                )
                if coverage < 0.5:
                    continue
                edge = not all(
                    _petal(x + dx, y + dy)
                    for dx, dy in ((-0.09, 0), (0.09, 0), (0, -0.09), (0, 0.09))
                )
                # Outlines resolve first; a restrained diagonal fill follows.
                if edge or fill >= min(1, (x + y + 2) / 4):
                    light = 0.65 + 0.2 * math.cos(x * 1.5 + y - phase)
                    canvas[row][col] = density[round(coverage * light * 6)] if fill else ":"
        lens_x, lens_y = round(cx), round(cy)
        if radius >= 5:
            for dy, line in ((-1, " ooo "), (0, "o   o"), (1, " ooo ")):
                for dx, character in enumerate(line):
                    canvas[lens_y + dy][lens_x + dx - 2] = character
        else:
            canvas[lens_y][lens_x] = "o"
        # A sparse halo keeps the silhouette clear; points travel continuously.
        for point in range(48):
            angle = point * math.tau / 48
            if point % 3 == 0:
                x, y = math.cos(angle) * 1.14, math.sin(angle) * 1.14
                px, py = round(cx + x * radius * 2), round(cy + y * radius)
                if 0 <= px < width and 0 <= py < canvas_height and canvas[py][px] == " ":
                    canvas[py][px] = "."
        for offset in (0, math.pi):
            angle = phase - math.pi / 2 + offset
            put(math.cos(angle) * 1.15, math.sin(angle) * 1.15, "*")
    left = " " * max(0, (width - max(map(len, wordmark))) // 2)
    return (
        ["".join(row).rstrip() for row in canvas] + [""] + [left + row.rstrip() for row in wordmark]
    )


def logo_frame(progress: float = 1.0, width: int = 70) -> str:
    """Orbiting light settles into three connected nodes and the Loci wordmark."""
    width = max(20, min(width, 70))
    if width < 58:
        return (
            "    .---.   .---.\n    ( o )---( o )\n"
            "     '---. .---'\n      ( o )     Loci\n         '---'"
        )
    progress = max(0.0, min(progress, 1.0))
    canvas = [[" " for _ in range(width)] for _ in range(14)]

    def put(x: int, y: int, text: str) -> None:
        for index, character in enumerate(text):
            if 0 <= x + index < width and 0 <= y < len(canvas):
                canvas[y][x + index] = character

    # A shared halo makes the three focal nodes read as one instrument.
    # The arcs resolve behind the nodes, and a small central lens arrives last.
    for point in range(48):
        angle = point * math.tau / 48
        if point % 12 < 9 and point / 48 < min(progress / 0.7, 1):
            put(round(16 + 14 * math.cos(angle)), round(7 + 6 * math.sin(angle)), ".")
    if progress > 0.75:
        put(15, 7, "[+]")
    # Curved, staggered approach; the last third resolves without overshoot.
    centers = ((9, 4), (23, 4), (16, 10))
    ease = 1 - (1 - min(progress / 0.82, 1)) ** 3
    if progress < 0.92:
        for particle in range(30):
            node = particle % 3
            angle = particle * 2.39996 + progress * 3.2 * (1 if node != 1 else -1)
            radius = (1 - ease) * (4 + particle % 5)
            cx, cy = centers[node]
            x = round(cx + math.cos(angle) * radius * 1.45)
            y = round(cy + math.sin(angle) * radius * 0.65)
            put(x, y, "." if particle % 3 else "+")
    if progress >= 0.48:
        reveal = min(1, (progress - 0.48) / 0.25)
        for x in range(13, 20):
            if (x - 13) / 7 < reveal:
                put(x, 4, "-")
        for y in range(6, 9):
            if (y - 6) / 3 < reveal:
                put(10 + (y - 5), y, "\\")
                put(22 - (y - 5), y, "/")
    for index, (cx, cy) in enumerate(centers):
        arrival = max(0, min(1, (progress - index * 0.085) / 0.70))
        angle = (1 - arrival) * 2.1 + index * math.tau / 3
        radius = 5 * (1 - arrival) ** 3
        x, y = round(cx + math.cos(angle) * radius), round(cy + math.sin(angle) * radius)
        for dy, line in enumerate((".---.", "( o )", "'---'")):
            put(x - 2, y + dy - 1, line)
        if progress < 0.8:
            # Short orbital trail follows each node, separate from ambient particles.
            put(x - 4, y, ":")
    for row, line in enumerate(_WORDMARK):
        visible = max(0, min(len(line), round((progress - 0.55 - row * 0.025) * 4 * len(line))))
        put(35, 4 + row, line[:visible])
    if progress > 0.84:
        put(35, 10, "LOCAL IMAGE RESEARCH")
        put(35, 11, "source -> insight")
    return "\n".join("".join(row).rstrip() for row in canvas).rstrip()


def animate_logo(stream: TextIO, duration: float = 1.05) -> None:
    """Animate only after the caller grants a real TTY; always restore cursor/signals."""
    if not math.isfinite(duration) or not 0.2 <= duration <= 8:
        raise ValueError("Logo duration must be finite and between 0.2 and 8 seconds.")
    dimensions = shutil.get_terminal_size((80, 24))
    width = dimensions.columns
    if width < 58 or dimensions.lines < 17:
        stream.write(logo_frame(width=width) + "\n")
        stream.flush()
        return
    previous_term: Any = None
    if threading.current_thread() is threading.main_thread():
        previous_term = signal.getsignal(signal.SIGTERM)

        def terminate(number: int, _frame: Any) -> None:
            raise SystemExit(128 + number)

        signal.signal(signal.SIGTERM, terminate)
    rows = 0
    try:
        stream.write("\x1b[?25l")
        started = time.monotonic()
        frames = max(2, round(duration * 24))
        for index in range(frames + 1):
            frame = logo_frame(index / frames, width)
            # Fixed height prevents remnants when particles disappear or the title arrives.
            lines = frame.splitlines()
            if rows:
                stream.write(f"\x1b[{rows}A")
            for line in [*lines, *["" for _ in range(14 - len(lines))]]:
                stream.write("\r\x1b[2K\x1b[36m" + line + "\x1b[0m\n")
            stream.flush()
            rows = 14
            wait = started + duration * (index + 1) / frames - time.monotonic()
            if index < frames and wait > 0:
                time.sleep(wait)
    finally:
        with suppress(OSError, ValueError):
            stream.write("\x1b[0m\x1b[?25h")
            stream.flush()
        if previous_term is not None:
            signal.signal(signal.SIGTERM, previous_term)
