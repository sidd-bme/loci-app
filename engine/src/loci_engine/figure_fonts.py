"""Resolve local figure fonts and verify the glyphs that will actually be printed."""

from __future__ import annotations

import hashlib
import io
import os
from collections.abc import Sequence
from pathlib import Path

from PIL import ImageFont


def _supports(font: ImageFont.FreeTypeFont, characters: set[str]) -> bool:
    def glyph(character: str) -> tuple[tuple[int, int], bytes]:
        mask = font.getmask(character)
        return mask.size, bytes(mask)

    missing = {glyph("\ufffd"), glyph("\U0010ffff")}
    return all(glyph(character) not in missing for character in characters)


def verified_figure_font(
    size: int, labels: Sequence[str], *, allow_embedded: bool = False
) -> tuple[ImageFont.FreeTypeFont, dict[str, str]]:
    if any(len(label) > 1024 for label in labels) or any(
        ord(c) < 32 or ord(c) == 127 for label in labels for c in label
    ):
        raise ValueError("Figure labels contain unsupported control characters")
    characters = {c for label in labels for c in label if not c.isspace()}
    candidates = (
        Path("/System/Library/Fonts/Supplemental/Arial Unicode.ttf"),
        Path("/System/Library/Fonts/Supplemental/Arial.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
        Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts/arial.ttf",
    )
    for file in candidates:
        if not file.is_file() or file.is_symlink():
            continue
        with file.open("rb") as stream:
            data = stream.read(32 * 1024 * 1024 + 1)
        if len(data) > 32 * 1024 * 1024:
            continue
        font = ImageFont.truetype(io.BytesIO(data), size=size)
        if _supports(font, characters):
            break
    else:
        if not allow_embedded:
            raise ValueError(
                "No installed verified font supports all actual metric labels and units"
            )
        font = ImageFont.load_default(size=size)
        if not isinstance(font, ImageFont.FreeTypeFont) or not _supports(font, characters):
            raise ValueError(
                "No available figure font can print every character in the labels and units"
            )
        data = font.font_bytes
    family, style = font.getname()
    return font, {"family": family, "style": style, "sha256": hashlib.sha256(data).hexdigest()}
