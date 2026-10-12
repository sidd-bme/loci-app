import copy
import json
import os
import subprocess
import sys

import pytest
from test_agent_policy import make_study

from loci_engine.research_recipe_guide import recipe_guide


def test_static_guide_examples_validate_with_production_workbench_without_adoption(tmp_path):
    workbench, source, _ = make_study(tmp_path)
    guide = recipe_guide()
    assert guide["schema"] == "loci.recipe-guide/v1"
    assert {item["name"] for item in guide["examples"]} == {"components-2d", "watershed-3d"}
    before = workbench.snapshot()
    for example in guide["examples"]:
        request = copy.deepcopy(example["request"])
        request["source_id"] = source["id"]
        validated = workbench.validate_recipe(request)
        assert validated["selection"]["c"] == 0
        assert validated["estimated_working_bytes"] <= request["recipe"]["working_bytes"]
        assert len(validated["recipe_sha256"]) == 64
        assert validated["scientific_validation"] == "unvalidated-research-method"
    assert workbench.snapshot() == before
    assert str(tmp_path) not in json.dumps(guide)
    workbench.close()


def test_guide_processing_variants_match_existing_validator(tmp_path):
    workbench, source, _ = make_study(tmp_path)
    guide = recipe_guide()
    schema = guide["request_schema"]["properties"]["recipe"]["properties"]
    for variant in schema["steps"]["items"]["oneOf"]:
        properties = variant["properties"]
        step = {"op": properties["op"]["const"]}
        for field in variant["required"]:
            if field != "op":
                step[field] = 0.5
        request = {
            "source_id": source["id"],
            "selection": {"c": 0, "z": 1},
            "recipe": {"steps": [step]},
        }
        assert workbench.validate_recipe(request)["recipe"]["steps"] == [step]
    assert "flatfield" not in json.dumps(schema["steps"])
    assert schema["references"]["maxProperties"] == 0
    with pytest.raises(ValueError, match="Unknown scalar"):
        workbench.validate_recipe(
            {
                "source_id": source["id"],
                "recipe": {
                    "steps": [{"op": "unimplemented-step"}],
                },
            }
        )
    workbench.close()


def test_guide_returns_independent_documents_and_never_loads_numerical_backends(tmp_path):
    changed = recipe_guide()
    changed["examples"][0]["request"]["recipe"]["working_bytes"] = 0
    assert recipe_guide()["examples"][0]["request"]["recipe"]["working_bytes"] > 0
    process = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys; from loci_engine.research_recipe_guide import recipe_guide; "
            "assert recipe_guide()['schema'] == 'loci.recipe-guide/v1'; "
            "assert not {'numpy','scipy','skimage','cv2','torch','SimpleITK','onnxruntime'} "
            "& sys.modules.keys()",
        ],
        capture_output=True,
        text=True,
        timeout=10,
        env={**os.environ, "LOCI_MODEL_HOME": str(tmp_path / "absent-models")},
    )
    assert process.returncode == 0, process.stderr
