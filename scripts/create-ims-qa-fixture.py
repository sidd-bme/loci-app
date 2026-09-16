#!/usr/bin/env python3
"""Create the tiny modern-IMS fixture consumed by frozen-engine QA."""

from __future__ import annotations

import sys
from pathlib import Path

import h5py
import numpy as np


def _chars(value: str) -> np.ndarray:
    return np.asarray(list(value), dtype="S1")


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: create-ims-qa-fixture.py /absolute/path/to/fixture.ims", file=sys.stderr)
        return 2
    destination = Path(sys.argv[1]).resolve()
    first = np.arange(20, dtype=np.uint8).reshape(1, 4, 5) * 8
    second = np.flip(first, axis=2)
    with h5py.File(destination, "w") as ims:
        ims.attrs["ImarisDataSet"] = _chars("ImarisDataSet")
        ims.attrs["ImarisVersion"] = _chars("5.5.0")
        timepoint = (
            ims.create_group("DataSet")
            .create_group("ResolutionLevel 0")
            .create_group("TimePoint 0")
        )
        for index, pixels in enumerate((first, second)):
            channel = timepoint.create_group(f"Channel {index}")
            channel.attrs["ImageSizeX"] = _chars("5")
            channel.attrs["ImageSizeY"] = _chars("4")
            channel.attrs["ImageSizeZ"] = _chars("1")
            channel.attrs["HistogramMin"] = _chars("0")
            channel.attrs["HistogramMax"] = _chars("255")
            channel.create_dataset("Data", data=pixels, compression="gzip")
        info = ims.create_group("DataSetInfo")
        for index, (name, color) in enumerate(
            (("Signal A", "0 1 0"), ("Signal B", "1 0 1"))
        ):
            channel = info.create_group(f"Channel {index}")
            channel.attrs["Name"] = _chars(name)
            channel.attrs["Color"] = _chars(color)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
