import base64
import importlib.util
import json
from io import BytesIO
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parents[1] / "qa" / "interactive_mcp_client.py"
SPEC = importlib.util.spec_from_file_location("interactive_mcp_client", SCRIPT)
assert SPEC and SPEC.loader
interactive_mcp_client = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(interactive_mcp_client)
_canonical_json = interactive_mcp_client._canonical_json
_response_for_stdout = interactive_mcp_client._response_for_stdout
_discard_frame_remainder = interactive_mcp_client._discard_frame_remainder
_read_action = interactive_mcp_client._read_action
decode_image = interactive_mcp_client.decode_image
prepare_output = interactive_mcp_client.prepare_output
MAX_LINE_BYTES = interactive_mcp_client.MAX_LINE_BYTES


def test_native_image_decoding_checks_mime_bytes_and_base64(tmp_path):
    png = b"\x89PNG\r\n\x1a\nsmall-image"
    block = {
        "type": "image",
        "mimeType": "image/png",
        "data": base64.b64encode(png).decode(),
    }
    record, size = decode_image(block, tmp_path, 1, 100)
    assert size == len(png)
    assert record["mimeType"] == "image/png"
    assert record["sha256"]
    assert (tmp_path / "image-0001.png").read_bytes() == png
    with pytest.raises(ValueError, match="MIME"):
        decode_image({**block, "mimeType": "image/jpeg"}, tmp_path, 2, 100)
    with pytest.raises(ValueError, match="base64"):
        decode_image({**block, "data": "%%%"}, tmp_path, 2, 100)
    with pytest.raises(ValueError, match="Unsupported"):
        decode_image({**block, "mimeType": "image/gif"}, tmp_path, 2, 100)


def test_native_jpeg_and_bounds_are_enforced(tmp_path):
    jpeg = b"\xff\xd8\xff" + b"payload"
    block = {
        "type": "image",
        "mimeType": "image/jpeg",
        "data": base64.b64encode(jpeg).decode(),
    }
    image, _ = decode_image(block, tmp_path, 1, len(jpeg))
    assert image["path"].endswith("image-0001.jpg")
    with pytest.raises(ValueError, match="limit"):
        decode_image(block, tmp_path, 2, len(jpeg) - 1)


def test_output_path_is_exclusive_and_response_keeps_native_mcp_fields(tmp_path):
    output = prepare_output(tmp_path / "run")
    with pytest.raises(FileExistsError):
        prepare_output(output)
    doc = {
        "content": [{"type": "text", "text": "actual result"}],
        "isError": True,
        "structuredContent": {"answer": 7},
    }
    result, index, used = _response_for_stdout(doc, output, 1, 0)
    assert result == {
        "content": doc["content"],
        "isError": True,
        "structuredContent": {"answer": 7},
    }
    assert index == 1 and used == 0
    assert json.loads(_canonical_json(result)) == result


def test_image_response_materializes_file_without_base64_in_response(tmp_path):
    output = prepare_output(tmp_path / "run")
    png = b"\x89PNG\r\n\x1a\nimage"
    doc = {
        "content": [
            {
                "type": "image",
                "mimeType": "image/png",
                "data": base64.b64encode(png).decode(),
            }
        ],
        "isError": False,
        "structuredContent": {"rendered": True},
    }
    response, index, used = _response_for_stdout(doc, output, 1, 0)
    assert "data" not in response["content"][0]
    assert response["content"][0]["path"] == str((output / "image-0001.png").resolve())
    assert (output / "image-0001.png").read_bytes() == png
    assert index == 2 and used == len(png)
    assert response["structuredContent"] == doc["structuredContent"]


def test_oversized_frame_suffix_is_drained_before_next_action():
    valid_suffix = b'{"action":"toolcall","name":"must-not-run"}\n'
    stream = BytesIO(
        b"x" * (MAX_LINE_BYTES + 1) + valid_suffix + b'{"action":"close"}\n'
    )
    oversized_prefix = stream.readline(MAX_LINE_BYTES + 1)
    assert len(oversized_prefix) == MAX_LINE_BYTES + 1
    assert not oversized_prefix.endswith(b"\n")

    _discard_frame_remainder(stream)

    next_frame = stream.readline(MAX_LINE_BYTES + 1)
    assert _read_action(next_frame.decode().rstrip("\r\n")) == {"action": "close"}
