"""Launch only fixed local research commands in source and frozen runtimes."""

from __future__ import annotations

import sys


def research_command(arguments: list[str]) -> list[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable, "--cli", *arguments]
    return [sys.executable, "-m", "loci_engine.research_cli", *arguments]
