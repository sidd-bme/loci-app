#!/usr/bin/env python3
"""Run a packaged tissue QA harness with explicit isolated, pinned inputs.

Usage: run_packaged_tissue_extension.py PACKAGE_DIR PACKET_DIR [harness]

PACKAGE_DIR holds the read-only assignment package (INPUTS.json, verify_package.py).
PACKET_DIR is the immutable source packet printed by prepare_qa.py. The harness defaults
to tests/tissue-model-correction.qa.mjs. Nothing is downloaded or copied into Git.
"""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys

assert len(sys.argv) in (3, 4), __doc__
package = Path(sys.argv[1]).resolve(strict=True)
packet = Path(sys.argv[2]).resolve(strict=True)
harness = sys.argv[3] if len(sys.argv) == 4 else "tests/tissue-model-correction.qa.mjs"
config = json.loads((package / "INPUTS.json").read_text())
root = Path(config["worktree"])
assert packet.is_relative_to(Path(config["output_root"]).resolve())
candidate = json.loads((packet / "candidate.json").read_text())
assert candidate["worktree"] == str(root)
head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
assert head == candidate["source_commit"], "Candidate packet and current HEAD differ"
app = Path(candidate["app"])
manifest = json.loads((app / "Contents/Resources/loci-build-identity.json").read_text())
assert manifest["sourceRevision"] == head and manifest["sourceDirty"] is False
assert manifest["buildNumber"] == candidate["build"]["buildNumber"]
subprocess.run(["python3", str(package / "verify_package.py")], check=True)
stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
output = Path(config["output_root"]) / ("packaged-extension-" + stamp)
output.mkdir(parents=True, exist_ok=False)
env = dict(os.environ)
env.update(
    {
        "PATH": config["node_directory"] + os.pathsep + env.get("PATH", ""),
        "LOCI_PACKAGED_APP": str(app),
        "LOCI_QA_PYTHON": str(root / "engine/.venv/bin/python"),
        "LOCI_QA_OUTPUT_ROOT": str(output),
        "LOCI_QA_SOURCE_COMMIT": head,
        "LOCI_QA_TISSUE_FREEZE": str(packet / "engine-packet.json"),
        "LOCI_QA_TISSUE_DESKTOP_PACKET": str(packet / "desktop-packet.json"),
    }
)
for variable, name in {
    "LOCI_QA_TISSUE_SOURCE": "source",
    "LOCI_QA_TISSUE_WEIGHTS": "weights",
    "LOCI_QA_TISSUE_CONVERSION_RECEIPT": "conversion_receipt",
    "LOCI_QA_TISSUE_REFERENCE_RECEIPT": "reference_receipt",
    "LOCI_QA_TISSUE_REFERENCE_CLASSES": "reference_classes",
    "LOCI_QA_TISSUE_REFERENCE_PROBABILITIES": "reference_probabilities",
}.items():
    env[variable] = config["inputs"][name]["path"]
command = [str(Path(config["node_directory"]) / "node"), harness]
record = {
    "command": command,
    "cwd": str(root / "desktop"),
    "environment": {
        k: v for k, v in env.items() if k.startswith("LOCI_QA_") or k == "LOCI_PACKAGED_APP"
    },
    "candidate": candidate,
    "log": str(output / "harness.log"),
}
(output / "invocation.json").write_text(json.dumps(record, indent=2) + "\n")
print("Harness output: " + str(output), flush=True)
with (output / "harness.log").open("w") as log:
    result = subprocess.run(
        command, cwd=root / "desktop", env=env, stdout=log, stderr=subprocess.STDOUT
    )
record["exit_code"] = result.returncode
(output / "invocation.json").write_text(json.dumps(record, indent=2) + "\n")
print("Harness exit code: " + str(result.returncode), flush=True)
sys.exit(result.returncode)
