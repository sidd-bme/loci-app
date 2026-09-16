# PyInstaller requires the hook-<import-name>.py filename convention.
# ruff: noqa: N999
"""Bundle the MCP service without importing its optional developer CLI."""

from PyInstaller.utils.hooks import collect_all, is_module_or_submodule

datas, binaries, hiddenimports = collect_all(
    "mcp", filter_submodules=lambda name: not is_module_or_submodule(name, "mcp.cli")
)
excludedimports = ["mcp.cli"]
