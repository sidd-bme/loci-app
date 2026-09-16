# Durable remote recipe workflow

`research_remote.execute_remote(workbench, operation, request)` is the shared
backend service for GUI and CLI integration. It composes the fixed SSH/scheduler
transport with strict remote-result attachment. It does not expose a shell,
command string, remote path override, runtime installation, arbitrary egress
destination, or generic worker operation.

The operation catalog is available as `REMOTE_OPERATION_CATALOG`:

| Operation | Request | Result |
| --- | --- | --- |
| `profile_save` | Exact private profile fields below | `{profile}` public DTO |
| `profile_list` | `{}` | `{profiles}` public DTO list |
| `profile_test` | `{"alias": string}` | Tested `{profile}` |
| `readiness` | `{"alias": string}` | Root/runtime-ready `{profile}` |
| `run_list` | `{}` | Resumable public `{runs}` list |
| `stage` | Exact authorized run specification below | Durable staged `{run}` |
| `submit` | `{"alias": string, "request_key": hex32}` | Submitted `{run}` |
| `status` | Same alias/key pair | Refreshed `{run}` |
| `logs` | Alias/key, `stderr` boolean, and byte `limit` | Redacted bounded log text |
| `cancel` | Same alias/key pair | Cancel-requested `{run}` |
| `retrieve` | Alias/key plus `"transfer_authorized": true` | Retrieved `{run}` |
| `attach` | Alias/key; optional `local_job_id` | `{run, attachment}` |
| `remove_owned` | Alias/key/hash plus `"cleanup_authorized": true` | Cleanup receipt and `{run}` |

## Save and test a fixed profile

`profile_save` accepts exactly these fields. Nullable fields must be present with
`null`; `expected_revision` is `0` when creating a profile and the current public
revision when replacing it.

```json
{
  "alias": "vanda",
  "known_host": "vanda.example.org",
  "known_hosts_file": "/absolute/private/known_hosts",
  "host_key_sha256": "SHA256:...",
  "runtime_python": "/approved/loci/runtime/bin/python",
  "remote_project_root": "/approved/project/root",
  "remote_output_root": "/approved/output/root",
  "remote_input_roots": ["/approved/read-only/images"],
  "scheduler": "pbspro",
  "scheduler_bin_dir": "/approved/pbs/bin",
  "identity_file": null,
  "queue": "batch",
  "account": null,
  "pbs_gpu_resource": null,
  "allow_direct_compute": false,
  "connect_timeout_seconds": 10,
  "resources": {
    "cpus": 4,
    "memory_mb": 16384,
    "wall_minutes": 60,
    "gpus": 0
  },
  "expected_revision": 0
}
```

The workflow accepts PBS, PBS Pro, or Slurm profiles. It also accepts `direct`
only when the profile sets `allow_direct_compute: true`; this is an explicit
operator declaration that the SSH alias is a standalone compute host approved
for direct execution. Direct profiles cannot include scheduler bin, queue,
account, or PBS resource fields. A profile may reserve GPUs only for a staged
Cellpose task whose requested device is `cuda`; CPU Cellpose and classical-only
requests require `gpus: 0`. Later
operations accept the saved alias and cannot override roots, runtime, scheduler,
queue, account, SSH identity, or resources.

The full profile is a private project document. Public DTOs contain its alias,
scheduler, fixed resources, revision, readiness timestamps, and the pinned
connection receipt. They omit host lookup names and every local or remote path.
`profile_test` verifies the SSH alias destination, pinned known-host fingerprint,
Linux runtime, scheduler, and approved existing roots, including every permitted
input root. `readiness` repeats those
checks, creates only Loci's private namespaces under the two roots, and verifies
the fixed `remote-worker` CLI contract.

## Stage an explicitly authorized run

`stage` accepts one stable 32-character lowercase hexadecimal request key. The
source list contains registered local source IDs. A source can either be
transferred from its registered local file or mapped to an existing file below
one of the saved permitted input roots.
Each task is either the unchanged fixed `run_recipe` contract or the exact
`run_cellpose` contract and must reference a source in that same list. A request
containing only recipes remains `loci.remote-worker-request/v1`; any Cellpose
task selects v2. This preserves byte-level compatibility for existing recipe
runs.

```json
{
  "alias": "vanda",
  "request_key": "0123456789abcdef0123456789abcdef",
  "sources": [{"source_id": "local-source-id-hex32"}],
  "tasks": [{
    "task_id": "task-id-hex32",
    "source_id": "local-source-id-hex32",
    "selection": {
      "x": 0, "y": 0, "width": 1024, "height": 1024,
      "t": 0, "c": 0, "z": 0, "level": 0
    },
    "recipe": {
      "steps": [],
      "segmentation": {"method": "components", "threshold": 100},
      "measurement_channels": [0],
      "gates": [],
      "working_bytes": 268435456
    }
  }],
  "transfer_authority": {
    "approved": true,
    "scope": "remote-run-recipe",
    "destination_alias": "vanda",
    "source_ids": ["local-source-id-hex32"]
  }
}
```

A Cellpose task contains no path, URL, model bytes, installer, or executable
payload. It binds the registered profile, Cellpose package, checkpoint artifact,
SHA-256, byte size, device, fallback policy, settings, measurement channels,
gates, working budget, and operator-declared rights basis:

```json
{
  "task_id": "task-id-hex32",
  "source_id": "local-source-id-hex32",
  "operation": "run_cellpose",
  "selection": {
    "x": 0, "y": 0, "width": 1024, "height": 1024,
    "t": 0, "c": 0, "z": 0, "level": 0
  },
  "cellpose": {
    "profile_id": "cellpose-sam-v2",
    "package_version": "4.2.1.1",
    "artifact_id": "cpsam_v2",
    "model_sha256": "0f1cc3f7ecdd8a037a57c6c48d9d8921391be4cbce3fa9f13c3e3a2e1253c667",
    "model_size_bytes": 1233586851,
    "requested_device": "cuda",
    "allow_cpu_fallback": false,
    "rights_basis": "noncommercial-research",
    "settings": {
      "max_edge_px": 1000, "diameter_px": 0.0,
      "flow_threshold": 0.4, "cellprob_threshold": 0.0,
      "min_size_px": 15, "max_size_fraction": 0.4,
      "niter": 250, "batch_size": 8, "resample": true,
      "augment": false, "tile_overlap": 0.1, "normalize": true,
      "percentile_low": 1.0, "percentile_high": 99.0,
      "tile_norm_blocksize": 0, "sharpen_radius": 0.0,
      "smooth_radius": 0.0, "invert": false, "device": "cuda"
    },
    "measurement_channels": [0],
    "gates": [],
    "working_bytes": 268435456
  }
}
```

The only accepted rights declarations are `noncommercial-research` and
`written-commercial-clearance`. Loci records the declaration but does not treat
it as independently verified legal clearance. The checkpoint must already be
installed in the remote runtime's managed Cellpose store. The worker verifies
the exact registered package version, checkpoint size, and checkpoint SHA-256
before inference; it never downloads or stages a model. `requested_device` is
limited to `cpu` or `cuda` and must equal `settings.device`. CUDA requires at
least one scheduler GPU. When `allow_cpu_fallback` is false, a CUDA failure or
any other device fallback aborts before result publication. An authorized
fallback is recorded with the requested device, resolved device, reason, memory
preflight, Python and Torch versions, CUDA runtime, and cuDNN identity.

An existing remote file uses a root index rather than a caller-selected absolute
path. The mapping must repeat the registered source's exact SHA-256 and byte size:

```json
{
  "source_id": "local-source-id-hex32",
  "remote_input": {
    "root_index": 0,
    "relative_path": "cohort/image.ome.tif",
    "source_sha256": "registered-source-sha256",
    "size_bytes": 123456
  }
}
```

The worker requires the saved root to resolve as a plain directory, traverses
each relative component without links, rejects overlap with either managed run
root, and rehashes the file before use. The mapping contributes to the canonical
request hash. Cleanup never touches a permitted input root.

The authority source list must exactly equal the ordered staged source list.
Loci revalidates each local full-file fingerprint, resolves each selection and
recipe or Cellpose contract locally, derives conservative remote filenames, and rejects medical,
OME-Zarr, reference-image, source-path, or resource overrides. Limits are 1,000
sources and 1,000 tasks at this service boundary, 1–16 arrays per attached task,
512 MiB per array, and the saved profile's memory policy per task.
The public run records the fixed transfer scope and authorization timestamp.

Before any remote reservation or transfer, Loci persists a private run document
containing the exact canonical `RemoteWorkerRequest` bytes as base64 and their
SHA-256. The public run DTO exposes the hash, never the bytes or resolved output
root. It also exposes the saved profile revision and profile SHA-256 bound to the
run. Later network operations fail closed if that profile changes; an operator
must restore or explicitly reconcile the profile instead of silently moving an
in-flight run to other roots or a different runtime. Identical retries compare
the complete reconstructed bytes. Reusing the key
with any different profile, project, source, task, selection, recipe, resource,
or output-root binding is rejected.

Staging reconnects through a newly host-verified client, checks the fixed worker
runtime, reserves the two marked run namespaces, transfers only the authorized
source files, then stages the exact request and fixed scheduler script. A failed
or interrupted attempt remains `prepared`; retrying the identical request safely
replays idempotent transport steps.

## Submit, recover, inspect, and cancel

`submit` reconstructs `RemoteRequest` only from the persisted bytes and identity.
The transport's remote `submit.json` makes the request key idempotent. If the
scheduler accepted work but the response was lost, the local record stays
`staged`; retrying the same alias and key reads the same remote submission and
recovers its job ID without another scheduler submission. Any returned request,
hash, or scheduler mismatch fails without advancing durable state.

`status`, `logs`, and `cancel` use only that persisted remote job identity. Direct
status reports success only after the process exits with a verified output
manifest; an exited process without one is failed with a bounded diagnostic.
`logs` reads at most 64 KiB from an owned stdout or stderr file and redacts saved
remote paths before returning renderer-safe text. Cancellation
sets `cancel_requested` locally after the fixed scheduler cancellation succeeds.
Cancelled runs cannot retrieve or attach results. The service accepts bounded
status detail from `RemoteJobStatus` up to 4,096 encoded bytes; it does not expose
a remote log or command reader.

## Retrieve and attach

`retrieve` requires a fresh explicit `transfer_authorized: true`. The destination
is always the private project cache `.remote-results/<request_key>` and cannot be
supplied by a caller. The transport verifies the remote ownership marker and
manifest before and after transfer; the service then rechecks every local file.
The successful authorization time is retained in the run DTO.
If a process stopped after successful transfer but before recording it, an exact
manifest-matching cache is adopted on retry. Any linked, extra, missing, changed,
or mismatched cached entry is rejected.

`attach` reconstructs the verified output manifest and exact original request
bytes from the run document, maps each remote request source back to its same
registered local source ID, and invokes `attach_remote_results`. The strict
attachment checks, measurement reconstruction, atomic SQLite publication,
unreviewed state, and retry semantics are documented in
[`REMOTE_RESULTS.md`](REMOTE_RESULTS.md). An optional local running job ID may be
bound to the same atomic result publication.

The public run state progresses through `prepared`, `staged`, `submitted`, remote
status states, `finished`, `retrieved`, `attached`, and `cleaned`; cancellation records
`cancel_requested`. Profile and run documents use optimistic revisions, so two
processes cannot silently overwrite one another.

## Remove verified owned run data

`remove_owned` requires the exact request SHA-256 and fresh
`cleanup_authorized: true`. It is unavailable until retrieval and attachment are
both present and reverified locally. Before deletion, Loci fetches the remote
manifest again and durably records cleanup preparation. The fixed transport then
checks the saved submission's scheduler, job ID, request key, request hash, and
both ownership markers. It writes an identity-bound tombstone under the fixed
`.loci-cleanups` namespace before removing exactly the staging and output run
directories. A retry after a lost response resumes from that tombstone and can
never accept absence alone as proof of ownership. The final public receipt keeps
the request, scheduler, server job, state, and count of removed owned roots;
remote paths stay private. Attached local results and the verified local archive
remain intact.

## Current boundaries

- Only registered plain native files and the fixed `run_recipe` and
  `run_cellpose` operations are supported. Cellpose is one 2D selected plane;
  the fixed profiles are `cellpose-sam-v2` and website-compatible
  `cellpose-sam`. Existing remote input mapping is limited to a plain file below a
  saved root. Tree-backed OME-Zarr, DICOM series, and external reference images
  need separate manifested transfer contracts.
- The workflow does not provision a runtime, checkpoint, or scientific method.
  A compatible runtime and exact rights-cleared checkpoint must already exist at
  the approved path and managed model location.
- Network interruption recovery relies on the remote ownership markers,
  content hashes, and idempotent submission record. Scheduler/site outages still
  require an operator to restore connectivity before retry.
- Retrieval and structural/measurement verification do not establish biological
  validity, clinical performance, or independence of tiles, planes, or patches.
