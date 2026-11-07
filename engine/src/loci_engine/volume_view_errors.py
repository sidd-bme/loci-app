"""Fixed, path-free GUI volume failures safe at the external-agent boundary."""

from typing import Literal

VolumeViewErrorCode = Literal["VIEW_STALE", "VIEW_UNAVAILABLE", "VIEW_BUSY"]
_PUBLIC_MESSAGES = {
    "VIEW_STALE": "VIEW_STALE: The volume view changed. Read the latest GUI view before retrying.",
    "VIEW_UNAVAILABLE": "VIEW_UNAVAILABLE: No ready saved GUI volume view is available.",
    "VIEW_BUSY": "VIEW_BUSY: Finish the current GUI volume interaction before retrying.",
}


class VolumeViewError(ValueError):
    """An allowlisted code, never caller- or decoder-supplied diagnostic text."""

    def __init__(self, code: VolumeViewErrorCode) -> None:
        if not isinstance(code, str) or code not in _PUBLIC_MESSAGES:
            raise ValueError("Unsupported public volume view error code")
        self.code = code
        self.public_message = _PUBLIC_MESSAGES[code]
        super().__init__(self.public_message)
