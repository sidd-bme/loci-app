"""Check the local microscopy files and credits used by the packaged Model Zoo."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from urllib.parse import urlsplit

from PIL import Image, ImageChops

EXAMPLES = (
    Path(__file__).resolve().parents[2] / "desktop/src/renderer/model-zoo/examples"
)
PROFILE_IDS = {
    "cellpose-sam-v2",
    "micro-sam-vit-b-lm",
    "stardist-2d-versatile-fluo",
    "bioimageio-nuclei-boundary-onnx",
    "puma-tissue-cpu",
}


def verify_example(directory: Path) -> dict:
    credit = json.loads((directory / "credit.json").read_text())
    assert credit["modelId"] == directory.name
    for field in (
        "modelVersion",
        "subject",
        "attribution",
        "imageLicense",
        "displayTransform",
    ):
        assert isinstance(credit[field], str) and credit[field].strip(), (
            directory.name,
            field,
        )
    for field in ("sourceUrl", "publicationUrl", "licenseUrl"):
        link = urlsplit(credit[field])
        assert link.scheme == "https" and link.hostname and not link.username, (
            directory.name,
            field,
        )

    paired = credit["kind"] == "prediction"
    assert paired or credit["kind"] == "input-only"
    assert bool(credit["predictionOrigin"]) == paired
    required = {"original.webp", "thumbnail.webp"}
    if paired:
        required.add("overlay.webp")
    files = {
        path.name
        for path in directory.iterdir()
        if path.suffix.lower() in {".png", ".webp"}
    }
    assert required <= files and files == set(credit["files"]), directory.name
    assert paired or not ({"overlay.webp", "prediction.png"} & files)

    dimensions = {}
    for name in sorted(files):
        path = directory / name
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        assert digest == credit["files"][name]["sha256"], name
        with Image.open(path) as image:
            image.load()
            assert image.format == {".webp": "WEBP", ".png": "PNG"}[path.suffix.lower()]
            assert list(image.size) == credit["files"][name]["dimensionsXY"], name
            dimensions[name] = image.size
    w, h = dimensions["original.webp"]
    tw, th = dimensions["thumbnail.webp"]
    assert tw <= w and th <= h, (directory.name, "thumbnail exceeds the source field")
    if paired:
        assert dimensions["overlay.webp"] == (w, h)
        with (
            Image.open(directory / "original.webp") as source,
            Image.open(directory / "overlay.webp") as overlay,
        ):
            difference = ImageChops.difference(
                source.convert("RGB"), overlay.convert("RGB")
            )
            assert difference.getbbox() is not None, (
                directory.name,
                "identical comparison images",
            )
        if "prediction.png" in dimensions:
            assert dimensions["prediction.png"] == (w, h)
    preview_source = "overlay.webp" if paired else "original.webp"
    with (
        Image.open(directory / preview_source) as full,
        Image.open(directory / "thumbnail.webp") as thumbnail,
    ):
        expected = full.convert("RGB").resize((tw, th), Image.Resampling.LANCZOS)
        assert (
            ImageChops.difference(expected, thumbnail.convert("RGB")).getbbox() is None
        ), (
            directory.name,
            "the card must show the same field, contrast and prediction layer as its detail view",
        )
    return {"model_id": directory.name, "kind": credit["kind"], "sizes_xy": dimensions}


if __name__ == "__main__":
    assert {path.name for path in EXAMPLES.iterdir() if path.is_dir()} == PROFILE_IDS
    print(
        json.dumps(
            [verify_example(EXAMPLES / model_id) for model_id in sorted(PROFILE_IDS)]
        )
    )
