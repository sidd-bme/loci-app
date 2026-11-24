"""PyInstaller entry point for the isolated Loci analysis worker."""

import sys

_TRACKER_FLAGS = ["-B", "-S", "-I", "-c"]


def _run_resource_tracker(arguments: list[str]) -> None:
    """Handle the frozen CPython resource tracker without interpreting its command."""
    import os
    import re
    import stat

    if len(arguments) != 5 or arguments[:4] != _TRACKER_FLAGS:
        raise SystemExit("Unsupported frozen worker arguments")
    match = re.fullmatch(
        r"from multiprocessing\.resource_tracker import main;main\(([1-9][0-9]{0,9})\)",
        arguments[4],
    )
    if match is None:
        raise SystemExit("Unsupported frozen resource tracker command")

    descriptor = int(match[1])
    try:
        inherited_pipe = 3 <= descriptor <= 2**31 - 1 and stat.S_ISFIFO(
            os.fstat(descriptor).st_mode
        )
    except OSError:
        inherited_pipe = False
    if not inherited_pipe:
        raise SystemExit("The frozen resource tracker requires an inherited pipe")

    # The standard frozen diversion can execute interpreter arguments. Loci
    # supports only the tracker command it emits and calls the entry directly.
    from multiprocessing.resource_tracker import main as resource_tracker_main

    resource_tracker_main(descriptor)


if __name__ == "__main__":
    arguments = sys.argv[1:]
    if getattr(sys, "frozen", False) and arguments and arguments[0] not in {"--cli", "--loci"}:
        _run_resource_tracker(arguments)
        raise SystemExit(0)
    if arguments and arguments[0] == "--cli":
        from loci_engine.research_cli import main as research_main

        raise SystemExit(research_main(arguments[1:]))
    from loci_engine.worker import main

    main()
