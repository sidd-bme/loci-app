"""Offline, authored geometric practice source; no analysis or review is fabricated.

The generated source and its provenance are siblings of the derived study. Only
trusted desktop main allocates the destination. This is not an MCP operation.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import tempfile
from pathlib import Path

import numpy as np
import tifffile

from .export import _fsync_directory, _rename_noreplace
from .research_project import ResearchProject, canonical_json
from .workbench import Workbench

EXAMPLE_ID = "synthetic-shapes-v1"
EXAMPLE_TITLE = "Synthetic shapes practice"
SOURCE_NAME = "synthetic-shapes-v1.ome.tiff"
# Exclusive bounds are Y0, Y1, X0, X1; row-major components produce IDs 1, 2, 3.
RECTANGLES = ((32, 48, 32, 52, 100), (80, 104, 128, 160, 150), (160, 192, 64, 80, 200))
OME_XML = """<?xml version="1.0" encoding="UTF-8"?>
<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06"
 UUID="urn:uuid:4af46791-9605-4fd8-9fd1-15a3d6b1041b">
 <Image ID="Image:0" Name="Synthetic geometric shapes v1">
  <Description>Authored mathematical shapes. Not cells or biological validation.</Description>
  <Pixels ID="Pixels:0" DimensionOrder="XYZCT" Type="uint16"
   SizeX="256" SizeY="256" SizeZ="1" SizeC="1" SizeT="1"
   PhysicalSizeX="0.5" PhysicalSizeXUnit="&#181;m" PhysicalSizeY="0.5" PhysicalSizeYUnit="&#181;m">
   <Channel ID="Channel:0:0" Name="Synthetic scalar intensity" SamplesPerPixel="1"/>
   <TiffData IFD="0" PlaneCount="1"/>
  </Pixels>
 </Image>
</OME>"""


def write_example_source(destination: Path) -> dict:
    """Write one exclusively created TIFF; fixed XML omits generated UUID/time tags."""
    image = np.zeros((256, 256), dtype=np.uint16)
    for y0, y1, x0, x1, intensity in RECTANGLES:
        image[y0:y1, x0:x1] = intensity
    with destination.open("xb") as stream:
        tifffile.imwrite(
            stream,
            image,
            byteorder="<",
            description=OME_XML,
            metadata=None,
            photometric="minisblack",
            software="Loci synthetic shapes v1",
            datetime=False,
        )
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(destination, 0o444)
    return {
        "schema": "loci.synthetic-example/v1",
        "example_id": EXAMPLE_ID,
        "source_name": SOURCE_NAME,
        "source_sha256": hashlib.sha256(destination.read_bytes()).hexdigest(),
        "source_size_bytes": destination.stat().st_size,
        "license": "CC0-1.0",
        "creator": "Loci contributors",
        "generator": "loci_engine.research_example.write_example_source",
        "generator_version": 1,
        "axes": "YX",
        "shape": [256, 256],
        "dtype": "uint16",
        "calibration": {"x": 0.5, "y": 0.5, "unit": "um", "basis": "authored, not measured"},
        "background": 0,
        "rectangles_y0_y1_x0_x1_intensity": [list(item) for item in RECTANGLES],
        "purpose": "Geometric workflow practice; no biological or accuracy claim",
    }


def create_example_study(destination: str | Path) -> ResearchProject:
    """Publish an absent study only after its immutable source imported successfully."""
    requested = Path(destination)
    if not requested.is_absolute() or not requested.name.endswith(".loci-study"):
        raise ValueError("Example destination must be an absolute .loci-study location")
    parent = requested.parent.resolve(strict=True)
    target = parent / requested.name
    source_target = parent / (requested.name + ".source")
    if any(item.exists() or item.is_symlink() for item in (target, source_target)):
        raise ValueError("Example destination exists; existing work is never overwritten")
    staging = Path(tempfile.mkdtemp(prefix=".loci-example-", dir=parent))
    staging_identity = ResearchProject._directory_identity(staging)
    published_source_identity = None
    workbench = None
    try:
        source_staging = staging / "source"
        source_staging.mkdir(mode=0o700)
        provenance = write_example_source(source_staging / SOURCE_NAME)
        with (source_staging / "provenance.json").open("x", encoding="utf-8") as stream:
            stream.write(canonical_json(provenance) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        _fsync_directory(source_staging)
        # Raw source locators must remain outside the derived study. Publish this
        # exclusively owned source first; rollback removes only this exact inode.
        published_source_identity = ResearchProject._directory_identity(source_staging)
        _rename_noreplace(source_staging, source_target)
        _fsync_directory(parent)
        project = ResearchProject.create(
            staging / "practice.loci-study", EXAMPLE_TITLE, schema_version=2
        )
        workbench = Workbench(project)
        source = workbench.import_native(str(source_target / SOURCE_NAME))
        project.meta["first_study"] = {
            **provenance,
            "source_id": source["id"],
        }
        with project.connection() as connection:
            connection.execute(
                "UPDATE metadata SET value=? WHERE key='project'", (canonical_json(project.meta),)
            )
        workbench.close()
        workbench = None
        _fsync_directory(project.root)
        _rename_noreplace(project.root, target)
        # Do not roll back published data if a subsequent durability check fails.
        published_source_identity = None
        _fsync_directory(parent)
        return ResearchProject(target)
    except BaseException:
        if (
            published_source_identity is not None
            and source_target.exists()
            and ResearchProject._directory_identity(source_target) == published_source_identity
        ):
            shutil.rmtree(source_target)
        raise
    finally:
        if workbench is not None:
            workbench.close()
        if staging.exists() and ResearchProject._directory_identity(staging) == staging_identity:
            shutil.rmtree(staging)
