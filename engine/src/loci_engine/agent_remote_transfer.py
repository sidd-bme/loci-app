"""Fixed disposable SCP helper: bound artifact writes before exec, without a shell."""

from __future__ import annotations

import os
import shlex
from pathlib import Path


def exec_bounded_scp(file_size_limit: int, arguments: list[str]) -> None:
    # Accept only the already-validated transport's fixed SCP grammar. In
    # particular no recursive copies, custom executable, proxy or shell options.
    prefix = ["scp", "-p", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o"]
    if (
        os.name != "posix"
        or type(file_size_limit) is not int
        or not 1 <= file_size_limit <= 512 * 1024**3
    ):
        raise ValueError("This host cannot enforce the bounded SCP file-size contract")
    if not isinstance(arguments, list) or arguments[:7] != prefix or len(arguments) not in {13, 17}:
        raise ValueError("Bounded transfer requires the fixed SCP argument vector")
    from .remote_compute import _ALIAS, _REMOTE_PATH, _known_hosts_option

    try:
        paths = shlex.split(arguments[7].split("=", 1)[1])
        pinned = Path(paths[0].replace("%%", "%")) if len(paths) == 1 else None
    except (IndexError, ValueError):
        pinned = None
    if (
        not arguments[7].startswith("UserKnownHostsFile=")
        or pinned is None
        or not pinned.is_absolute()
        or _known_hosts_option(pinned) != arguments[7]
        or arguments[8] != "-o"
        or not arguments[9].startswith("ConnectTimeout=")
    ):
        raise ValueError("Bounded SCP requires the pinned transport options")
    timeout = arguments[9].split("=", 1)[1]
    if not timeout.isdecimal() or not 1 <= int(timeout) <= 120:
        raise ValueError("Bounded SCP connection timeout is invalid")
    tail = arguments[10:]
    if len(tail) == 7:
        if tail[:3] != ["-o", "IdentitiesOnly=yes", "-i"] or not Path(tail[3]).is_absolute():
            raise ValueError("Bounded SCP identity option is invalid")
        tail = tail[4:]
    if len(tail) != 3 or tail[0] != "--" or ":" not in tail[1]:
        raise ValueError("Bounded SCP requires one exact remote source and local destination")
    alias, remote_path = tail[1].split(":", 1)
    if not _ALIAS.fullmatch(alias) or not _REMOTE_PATH.fullmatch(remote_path):
        raise ValueError("Bounded SCP source identity is invalid")
    destination = Path(tail[2])
    if not destination.is_absolute() or not destination.name.startswith(".incoming-"):
        raise ValueError("Bounded SCP destination must be the private incoming artifact")
    import resource

    resource.setrlimit(resource.RLIMIT_FSIZE, (file_size_limit, file_size_limit))
    # No new session: the supervisor owns this helper and its exec'd SCP through
    # the original transfer/adoption child's process group.
    os.execvp("scp", arguments)
