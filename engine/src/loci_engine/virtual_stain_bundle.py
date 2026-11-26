"""Directory-descriptor publication of the DynaCell image and sidecar."""

import os
import re
import uuid
from contextlib import ExitStack, contextmanager, suppress
from pathlib import PureWindowsPath

from .export import _rename_noreplace
from .research_data_export import _DIRECTORY_FLAGS, _capability, _destination, _verify_files


def validate_windows_path(path):
    if (
        not path.is_absolute()
        or not re.fullmatch(r"[a-zA-Z]:", path.drive)
        or any(
            part.endswith((" ", "."))
            or PureWindowsPath(part).is_reserved()
            or re.search(r'[\x00-\x1f<>:"|?*]', part)
            for part in path.parts[1:]
        )
    ):
        raise ValueError("Choose a canonical drive-letter path on a fixed local NTFS volume")


class _PosixBundle:
    def __init__(self, target, parent, stack):
        self.target = target
        self.parent = parent
        self.stack = stack
        self.location = ".loci-virtual-stain-" + uuid.uuid4().hex
        self.stage = None
        self.owned = {}
        self.registered = False

    def guard(self):
        parent = self.target.parent
        if (
            parent.resolve(strict=True) != parent
            or not os.path.samestat(parent.lstat(), os.fstat(self.parent))
            or (
                self.stage is not None
                and not os.path.samestat(
                    os.fstat(self.stage),
                    os.stat(self.location, dir_fd=self.parent, follow_symlinks=False),
                )
            )
        ):
            raise ValueError("Virtual stain destination directory changed")

    def start(self):
        self.guard()
        os.mkdir(self.location, 0o700, dir_fd=self.parent)
        self.stage = os.open(self.location, _DIRECTORY_FLAGS, dir_fd=self.parent)
        self.stack.callback(os.close, self.stage)
        self.stack.callback(self.rollback)

    def file(self, name):
        flags = os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
        descriptor = os.open(name, flags, 0o600, dir_fd=self.stage)
        self.owned[name] = os.fstat(descriptor)
        return os.fdopen(descriptor, "w+b")

    def verify(self, files):
        _verify_files(self.stage, files)
        self.guard()

    def publish(self):
        self.guard()
        os.fsync(self.stage)
        _rename_noreplace(
            self.location, self.target.name, src_dir_fd=self.parent, dst_dir_fd=self.parent
        )
        self.location = self.target.name
        os.fsync(self.parent)
        self.guard()

    def rollback(self):
        if self.registered:
            return
        for name, created in self.owned.items():
            with suppress(FileNotFoundError):
                current = os.stat(name, dir_fd=self.stage, follow_symlinks=False)
                if os.path.samestat(created, current):
                    os.unlink(name, dir_fd=self.stage)
        with suppress(FileNotFoundError):
            if not os.listdir(self.stage) and os.path.samestat(
                os.fstat(self.stage),
                os.stat(self.location, dir_fd=self.parent, follow_symlinks=False),
            ):
                os.rmdir(self.location, dir_fd=self.parent)


@contextmanager
def publication(project, target, inputs):
    with ExitStack() as stack:
        if os.name == "nt":
            from .virtual_stain_windows import WindowsBundle

            bundle = WindowsBundle(target, inputs, stack)
            _destination(project, target)
        else:
            _capability()
            _destination(project, target)
            parent = os.open(target.parent, _DIRECTORY_FLAGS)
            stack.callback(os.close, parent)
            bundle = _PosixBundle(target, parent, stack)
        bundle.guard()
        yield bundle
