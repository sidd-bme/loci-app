# Remote result attachment

Loci attaches completed remote recipe and Cellpose runs through a narrow,
fail-closed API:

```python
from loci_engine.research_remote_results import attach_remote_results

receipt = attach_remote_results(
    project,
    request_bytes,
    retrieved_results_zip,
    expected_archive_sha256=verified_manifest.entries[0].sha256,
    outer_manifest=verified_manifest,
    local_source_mapping={remote_source_id: local_source_id},
    local_job_id=running_job_id,  # optional
)
```

`request_bytes` must be the exact canonical request sent to the worker. A
reconstructed typed request is insufficient because `RemoteWorkerRequest` does
not retain the resolved output root that contributed to the original SHA-256.
`outer_manifest` must be the `VerifiedOutputManifest` returned by
`verify_output_manifest`; it must name exactly one `results.zip` entry. The ZIP
path must be an absolute, already retrieved plain file whose size and SHA-256
match that entry.

The source map is explicit and exhaustive. Every remote source identity must map
to a registered local source with the same size and full source fingerprint. Loci
re-reads the local source before validation and again before publication. It also
resolves the requested selection and recipe against the local reader, then checks
the published shape, physical grid, recipe hash, working-memory estimate, engine,
and runtime identities. Remote project, task, internal source, result, revision,
record, request, and archive identities remain in `provenance.remote_attachment`.
The attached result receives fresh local result and revision identities bound to
the local project and source.

The same attachment rule applies when computation used an already-remote source
below a saved permitted input root. The remote location is private request state;
the attachment is accepted only through the explicit local source mapping and
matching immutable source hash and size. A location match is never a substitute
for content identity.

The archive reader does not extract files. It accepts only the worker's canonical
ZIP layout: unique safe relative paths, sorted members, one final `archive.json`,
stored compression, fixed timestamps and permissions, regular-file entries, and
no comments, encryption, links, directories, traversal, or undeclared members.
Every size and SHA-256 is checked at the outer manifest, archive manifest, task
record, result record, array descriptor, and NPY payload layers. Loci parses the
bounded NPY v1 or v2 header and verifies its dimensions, dtype, and exact payload
length before NumPy may allocate the declared array. Numeric contents must contain
finite real values within the 512 MiB per-artifact bound. For segmented results,
labels must be compact positive integers matching the segmentation count. Loci
remeasures those uploaded labels against the exact locally selected raw channels
and requires every declared measurement field to match, with `1e-12` relative
and absolute tolerance for floating-point values. It does not rerun segmentation.

For `run_cellpose`, attachment uses a separate strict branch. It resolves the
exact 2D local selection and physical grid, requires only the canonical `image`
and `labels` arrays, verifies compact `uint32` labels and the
`cellpose-segmentation` result kind, and repeats the same local raw-channel
remeasurement. It does not require or run Cellpose locally. The importer instead
checks the request-bound profile, Cellpose 4.2.1.1 package, artifact identifier,
checkpoint SHA-256 and byte size, complete settings, requested and resolved
device, fallback authorization and reason, memory preflight, Python and Torch versions,
CUDA runtime, cuDNN identity, and operator-declared rights basis. An
unauthorized fallback, missing CUDA identity for a claimed CUDA result, changed
model identity, mismatched grid, or altered measurement rejects the entire
attachment.

All result rows, the attachment receipt, and an optional running local job update
are committed in one SQLite transaction. The exact local sources, staged array
hashes, and archive are rechecked while that final transaction holds its write
lock. A cancelled, stopped, or missing job rejects publication. Array blobs are
content-addressed staging artifacts and may remain unreferenced after a rejected
attachment; they are never visible as study results. Repeating an attachment
after a lost response returns the stored receipt only after revalidating every
referenced result revision and content-addressed array. The request SHA-256,
archive SHA-256, source map, and local job binding must match. Reusing the request
key with different inputs is rejected.

The outer archive and the sum of declared members are bounded at 512 GiB. An
archive may contain at most 50,001 ZIP entries including `archive.json`, with at
most 10,000 requested tasks. Canonical request JSON is bounded at 4 MiB, and task
and archive JSON records are each bounded at 16 MiB. The fixed recipe result
contract accepts exactly one `image` array, plus one `labels` array when
segmentation was requested. The Cellpose result contract requires exactly both
arrays on the selected source grid.

Remote review data is never adopted. The worker and importer require `unreviewed`
with no receipt, and no local review receipt is created. A human must review the
new local revision in the local study.

These checks establish transport integrity, exact source and request binding,
structural consistency, and reproducible provenance. They do not prove that the
remote computation is scientifically correct, validate a method for a biomedical
use, authenticate an untrusted worker beyond the trusted transfer and manifest
boundary, or replace local human review.
