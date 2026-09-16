"""Strict CycloneDX 1.6 validator used by the locked release-tools environment."""

from __future__ import annotations

import argparse
import sys
from importlib import metadata
from pathlib import Path

from cyclonedx.schema import SchemaVersion
from cyclonedx.validation.json import JsonStrictValidator

EXPECTED_CYCLONEDX_BOM_VERSION = "7.3.1"
EXPECTED_LIBRARY_VERSION = "11.12.0"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("documents", nargs="+")
    arguments = parser.parse_args()

    actual_bom = metadata.version("cyclonedx-bom")
    actual_library = metadata.version("cyclonedx-python-lib")
    if (
        actual_bom != EXPECTED_CYCLONEDX_BOM_VERSION
        or actual_library != EXPECTED_LIBRARY_VERSION
    ):
        print(
            "unexpected locked CycloneDX validator versions: "
            f"cyclonedx-bom={actual_bom}, cyclonedx-python-lib={actual_library}",
            file=sys.stderr,
        )
        return 2

    validator = JsonStrictValidator(SchemaVersion.V1_6)
    failed = False
    for raw_path in arguments.documents:
        path = Path(raw_path)
        try:
            document = path.read_text(encoding="utf-8")
            errors = validator.validate_str(document, all_errors=True)
        except (OSError, UnicodeError, ValueError) as exc:
            print(f"{path}: could not validate: {exc}", file=sys.stderr)
            failed = True
            continue
        if errors is None:
            continue
        failed = True
        for error in errors:
            print(f"{path}: {error}", file=sys.stderr)
    return 2 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
