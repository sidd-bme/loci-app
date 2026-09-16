"""PyInstaller entry point for the isolated Loci analysis worker."""

import sys

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--cli":
        from loci_engine.research_cli import main as research_main

        raise SystemExit(research_main(sys.argv[2:]))
    from loci_engine.worker import main

    main()
