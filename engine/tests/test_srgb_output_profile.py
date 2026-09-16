import base64
import hashlib
import io
import subprocess
import sys

from PIL import ImageCms

from loci_engine.native_image import SRGB_OUTPUT_PROFILE_SHA256, srgb_output_profile_bytes


def test_pinned_srgb_profile_is_valid_and_process_stable() -> None:
    profile = srgb_output_profile_bytes()

    assert len(profile) == 588
    assert hashlib.sha256(profile).hexdigest() == SRGB_OUTPUT_PROFILE_SHA256
    reopened = ImageCms.ImageCmsProfile(io.BytesIO(profile))
    assert ImageCms.getProfileName(reopened).strip() == "sRGB built-in"
    assert ImageCms.getProfileCopyright(reopened).strip() == "No copyright, use freely"

    encoded = subprocess.check_output(
        [
            sys.executable,
            "-c",
            "import base64; from loci_engine.native_image import srgb_output_profile_bytes; "
            "print(base64.b64encode(srgb_output_profile_bytes()).decode())",
        ],
        text=True,
    ).strip()
    assert base64.b64decode(encoded, validate=True) == profile
