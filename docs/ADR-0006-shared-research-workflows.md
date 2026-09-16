# ADR 0006: shared, durable research workflows

Accepted for implementation, 2026-09-07. See the
[release contract](RELEASE_CONTRACT.md); this decision does not certify delivery.

The existing cell workflow and project format remain supported. Native imaging
needs a general scalar image/volume, geometry, study and task model. Extend the
Python engine with bounded native readers and deterministic operations, then a
durable research project service. Use the same validated operations for desktop,
CLI, MCP and remote workers. Avoid separate algorithms in each client.

Research projects use an explicit `.loci-study` directory containing a versioned
transactional record database and immutable, hash-bound derived arrays. Sources
remain external and read-only. Private source locators are stored separately
from renderer/client-safe receipts. Native inspection distinguishes biological
channels from RGB samples; scalar operations use YX/ZYX and an XYZ voxel-center
to world affine, with declared units and LPS/RAS conventions where applicable.
Unknown calibration remains pixels, never inferred micrometres.

Each operation validates its full request, working-memory limit and input
identities before execution. Derived records retain selected region/plane/time,
geometry, executed settings, software/runtime/model identity and artifact hashes.
Immutable revisions support correction history, undo/redo and exact-revision
review. Task submission has an idempotency identity; state survives process
interruption. Export validates the selected revision and publishes atomically.
The existing `.loci-project` format is preserved; study interchange and legacy
handoff need explicit verified import rather than silent schema replacement.

The desktop provides a canvas-centered research workspace in the same shell.
Native channels, linked orthogonal views, measurements, recipes and studies use
the shared service. The existing cell workspace remains available during this
transition and for opening existing projects. Completion requires the new
workflows to be visible and usable in the packaged interface, with coherent
navigation and tested data handoff.

Local human operations acquire paths through native pickers/explicit CLI input.
MCP never receives those broad capabilities: a human-created bounded policy
fixes project/source/model/operation/output/resource/disclosure scope. Descriptive
metadata is untrusted data, not instructions. Metadata or previews sent to cloud
clients are egress and require declared permission. Remote execution remains
explicitly authorized, independent of local Auto device selection.

Native navigation may reuse a verified full-file fingerprint while checking
file identity, size and change timestamps around each read. This mode must be
reported as identity-checked navigation, not a fresh full hash. Analysis and
export boundaries strictly verify identity. Replaced or changed sources are
rejected; relinking requires an exact match. All decoded reads and intermediate
arrays have budgets. A bounded processing crop is explicit scientific scope.

SimpleITK is added for maintained physical-space medical I/O, pinned by the
engine lock; its exact distribution and dependency notices enter package
evidence. Classical CPU operations remain available without model weights.
Heavy model runtimes remain explicit, recoverable provisioning and do not
silently fetch artifacts.
